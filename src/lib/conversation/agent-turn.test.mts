// Unit tests for the external-agent turn orchestrator. A fake AgentTurnClient
// and a mocked llmCall exercise the lifecycle without a live Supabase or LLM:
//   - claim refused        → busy, no LLM call, no release
//   - happy path           → claim → refresh → events → insert → release
//                            (reason 'normal', produced true), status ok
//   - LLM throws           → release(produced=false), no insert, degraded
//   - wall-clock timeout    → release fired, degraded
//   - heartbeat refuses     → abort mid-turn, release attempted, degraded

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn, type AgentTurnClient, type ThreadMessage } from './agent-turn.mjs';
import type { LLMCall } from '#types/llm.mjs';

const AUTH = { userId: 'user-1', token: 'jwt-token' };
const INPUT = { conversationId: 'c1', sessionId: 's1', turnId: 't1' };

interface Recorded {
  order: string[];
  claimTurn: Array<{ token: string; ttl: number; turnId: string }>;
  refreshTurn: number;
  releaseTurn: Array<{ token: string; reason: string; produced: boolean }>;
  appendEvents: unknown[][];
  insertMessage: Array<{ content: unknown; sessionId: string }>;
}

interface FakeOptions {
  claimResult?: boolean;
  refreshResult?: boolean;
  thread?: ThreadMessage[];
  insertId?: string | null;
  /** Called once refreshTurn has been observed at least once. */
  onRefresh?: () => void;
}

function makeClient(opts: FakeOptions = {}): { client: AgentTurnClient; rec: Recorded } {
  const rec: Recorded = {
    order: [],
    claimTurn: [],
    refreshTurn: 0,
    releaseTurn: [],
    appendEvents: [],
    insertMessage: [],
  };
  const client: AgentTurnClient = {
    async claimTurn(token, ttlSeconds, turnId) {
      rec.order.push('claim');
      rec.claimTurn.push({ token, ttl: ttlSeconds, turnId });
      return opts.claimResult ?? true;
    },
    async refreshTurn(_token, _ttl) {
      rec.order.push('refresh');
      rec.refreshTurn += 1;
      opts.onRefresh?.();
      return opts.refreshResult ?? true;
    },
    async releaseTurn(token, reason, produced) {
      rec.order.push('release');
      rec.releaseTurn.push({ token, reason, produced });
    },
    async appendEvents(events) {
      rec.order.push('append');
      rec.appendEvents.push(events);
    },
    async insertMessage(content, sessionId) {
      rec.order.push('insert');
      rec.insertMessage.push({ content, sessionId });
      return opts.insertId === undefined ? 'm1' : opts.insertId;
    },
    async readThread(_limit) {
      rec.order.push('readThread');
      return opts.thread ?? [{ role: 'user', content: 'hi', actor: 'human' }];
    },
  };
  return { client, rec };
}

const constantLlm = (text: string): LLMCall => async () => text;
const throwingLlm = (): LLMCall => async () => {
  throw new Error('llm exploded');
};
const neverLlm = (): LLMCall => () => new Promise<string>(() => undefined);

describe('runAgentTurn', () => {
  it('rejects a caller with no JWT (defence in depth)', async () => {
    const { client } = makeClient();
    await assert.rejects(
      runAgentTurn(INPUT, { userId: 'u', token: '' }, { clientFactory: async () => client }),
      /requires a user JWT/,
    );
  });

  it('returns busy without an LLM call when the claim is refused', async () => {
    const { client, rec } = makeClient({ claimResult: false });
    let llmCalled = false;
    const llmCall: LLMCall = async () => {
      llmCalled = true;
      return 'x';
    };

    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall,
    });

    assert.equal(res.status, 'busy');
    assert.equal(llmCalled, false);
    assert.equal(rec.claimTurn.length, 1);
    assert.equal(rec.insertMessage.length, 0);
    assert.equal(rec.releaseTurn.length, 0, 'a refused claim releases nothing');
  });

  it('happy path: claim → refresh → events → insert → release(normal, produced=true)', async () => {
    let resolveLlm: (v: string) => void = () => undefined;
    const gate = new Promise<string>((r) => {
      resolveLlm = r;
    });
    const llmCall: LLMCall = () => gate;

    // Release the LLM only after the heartbeat has fired at least once, so the
    // refresh call is deterministically ordered before insert.
    const { client, rec } = makeClient({
      onRefresh: () => resolveLlm('  the agent reply  '),
    });

    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall,
      heartbeatIntervalMs: 5,
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.messageId, 'm1');

    // Call-order guarantees.
    const firstClaim = rec.order.indexOf('claim');
    const firstRefresh = rec.order.indexOf('refresh');
    const insertAt = rec.order.indexOf('insert');
    const releaseAt = rec.order.indexOf('release');
    assert.ok(firstClaim === 0, 'claim is first');
    assert.ok(firstRefresh > firstClaim, 'refresh after claim');
    assert.ok(rec.refreshTurn >= 1, 'heartbeat refreshed at least once');
    assert.ok(insertAt > firstRefresh, 'insert after refresh');
    assert.ok(releaseAt > insertAt, 'release is last');

    // Content trimmed; message shape is [{type:text,text}]; session threaded.
    assert.deepEqual(rec.insertMessage[0].content, [{ type: 'text', text: 'the agent reply' }]);
    assert.equal(rec.insertMessage[0].sessionId, 's1');

    // Both receipts appended before the insert.
    assert.equal(rec.appendEvents.length, 1);
    const events = rec.appendEvents[0] as Array<{ type: string }>;
    assert.deepEqual(events.map((e) => e.type), ['turn.started', 'turn.round-completed']);

    // Release: reason normal, produced true.
    assert.equal(rec.releaseTurn.length, 1);
    assert.equal(rec.releaseTurn[0].reason, 'normal');
    assert.equal(rec.releaseTurn[0].produced, true);
    // The same secret turn-token is used for claim and release.
    assert.equal(rec.releaseTurn[0].token, rec.claimTurn[0].token);
  });

  it('persists nothing (produced=false) when the LLM returns empty prose', async () => {
    const { client, rec } = makeClient();
    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall: constantLlm('   '),
    });

    assert.equal(res.status, 'ok');
    assert.equal(res.messageId, undefined);
    assert.equal(rec.insertMessage.length, 0);
    assert.equal(rec.releaseTurn[0].produced, false, 'produced=false when nothing persisted');
    assert.equal(rec.releaseTurn[0].reason, 'normal');
  });

  it('LLM throw → release(produced=false), no insert, degraded', async () => {
    const { client, rec } = makeClient();
    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall: throwingLlm(),
    });

    assert.equal(res.status, 'degraded');
    assert.equal(rec.insertMessage.length, 0, 'no message on failure');
    assert.equal(rec.releaseTurn.length, 1, 'the claim is still released');
    // Catch-path releases carry 'interrupted' so a degraded turn stays
    // distinguishable from a clean one (recette).
    assert.equal(rec.releaseTurn[0].reason, 'interrupted');
    assert.equal(rec.releaseTurn[0].produced, false);
  });

  it('wall-clock timeout → release fired, degraded (claim never left behind)', async () => {
    const { client, rec } = makeClient();
    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall: neverLlm(),
      turnTimeoutMs: 20,
      // Large heartbeat so only the timeout fires.
      heartbeatIntervalMs: 10_000,
    });

    assert.equal(res.status, 'degraded');
    assert.equal(rec.insertMessage.length, 0);
    assert.equal(rec.releaseTurn.length, 1, 'timeout still releases the claim');
    assert.equal(rec.releaseTurn[0].produced, false);
  });

  it('heartbeat refuses mid-turn → abort + release attempted, degraded', async () => {
    // refreshTurn returns false: the claim was stolen/expired. The in-flight
    // work (a never-resolving LLM) must be abandoned and the claim released.
    const { client, rec } = makeClient({ refreshResult: false });
    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall: neverLlm(),
      heartbeatIntervalMs: 5,
      turnTimeoutMs: 10_000,
    });

    assert.equal(res.status, 'degraded');
    assert.equal(rec.insertMessage.length, 0, 'no write under a lost claim');
    assert.ok(rec.refreshTurn >= 1, 'heartbeat attempted');
    assert.equal(rec.releaseTurn.length, 1, 'release attempted even on a lost claim');
    assert.equal(rec.releaseTurn[0].produced, false);
  });
});
