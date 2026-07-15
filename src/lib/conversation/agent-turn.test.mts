// Unit tests for the external-agent turn orchestrator. A fake AgentTurnClient
// and a mocked llmCall exercise the lifecycle without a live Supabase or LLM:
//   - claim refused        → busy, no LLM call, no release
//   - happy path           → claim → refresh → events → insert → release
//                            (reason 'normal', produced true), status ok
//   - LLM throws           → release(produced=false), no insert, degraded
//   - wall-clock timeout    → release fired, degraded
//   - heartbeat refuses     → abort mid-turn, release attempted, degraded
//   - quota deny ([A3])     → release(reason NULL), no LLM call, no message,
//                             'quota-exceeded' + QuotaRefused receipt
//   - quota read fails      → turn proceeds (fail-open) + QuotaCheckDegraded
//   - success               → one ai_calls spend row (source external-agent)
//   - ledger insert fails   → turn still ok + failure receipt

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn, type AgentTurnClient, type ThreadMessage } from './agent-turn.mjs';
import { recordLlmUsage } from '#lib/llm/usage-context.mjs';
import { setPostHogFlags } from '#lib/flags/state.mjs';
import type { PostHogFlags } from '#lib/flags/posthog.mjs';
import type { LLMCall } from '#types/llm.mjs';

const AUTH = { userId: 'user-1', token: 'jwt-token' };
const INPUT = { conversationId: 'c1', sessionId: 's1', turnId: 't1' };

interface Recorded {
  order: string[];
  claimTurn: Array<{ token: string; ttl: number; turnId: string }>;
  refreshTurn: number;
  releaseTurn: Array<{ token: string; reason: string | null; produced: boolean }>;
  appendEvents: unknown[][];
  insertMessage: Array<{ content: unknown; sessionId: string }>;
  aiCalls: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    source: string;
  }>;
}

interface FakeOptions {
  claimResult?: boolean;
  refreshResult?: boolean;
  thread?: ThreadMessage[];
  insertId?: string | null;
  /** Called once refreshTurn has been observed at least once. */
  onRefresh?: () => void;
  /** get_my_agent_usage() reply. Defaults to a well-formed under-limit row. */
  usage?: { ok: boolean; body: unknown };
  /** readAgentUsage throws (unreachable RPC) — the gate must degrade OPEN. */
  usageThrows?: boolean;
  /** recordAiCall throws (ledger insert failure) — the turn must survive. */
  recordAiCallThrows?: boolean;
}

function makeClient(opts: FakeOptions = {}): { client: AgentTurnClient; rec: Recorded } {
  const rec: Recorded = {
    order: [],
    claimTurn: [],
    refreshTurn: 0,
    releaseTurn: [],
    appendEvents: [],
    insertMessage: [],
    aiCalls: [],
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
    async readAgentUsage() {
      rec.order.push('readAgentUsage');
      if (opts.usageThrows) throw new Error('usage RPC unreachable');
      return (
        opts.usage ?? { ok: true, body: [{ agent_turns_today: 0, agent_turns_limit_day: 50 }] }
      );
    },
    async recordAiCall(record) {
      rec.order.push('recordAiCall');
      if (opts.recordAiCallThrows) throw new Error('ledger insert failed');
      rec.aiCalls.push(record);
    },
  };
  return { client, rec };
}

interface Captured {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}

/** Minimal PostHogFlags fake: only capture records; everything else inert. */
function makeFlags(): { flags: PostHogFlags; captured: Captured[] } {
  const captured: Captured[] = [];
  const flags: PostHogFlags = {
    async isRecipeEnabled() {
      return true;
    },
    async resolveRecipeVariant() {
      return undefined;
    },
    async resolvePromptVariants() {
      return {};
    },
    capture(event, distinctId, properties) {
      captured.push({ event, distinctId, properties });
    },
    async shutdown() {
      // inert
    },
  };
  return { flags, captured };
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

  // ─── [A3] quota gate + spend ledger (ADR-0027, PR-A3-2b) ──────────────────

  it('quota deny → quota-exceeded, claim released bare (reason NULL), no LLM, no message, QuotaRefused', async () => {
    const { flags, captured } = makeFlags();
    setPostHogFlags(flags);
    try {
      const { client, rec } = makeClient({
        usage: { ok: true, body: [{ agent_turns_today: 50, agent_turns_limit_day: 50 }] },
      });
      let llmCalled = false;
      const llmCall: LLMCall = async () => {
        llmCalled = true;
        return 'x';
      };

      const res = await runAgentTurn(INPUT, AUTH, {
        clientFactory: async () => client,
        llmCall,
      });

      assert.equal(res.status, 'quota-exceeded');
      assert.equal(res.messageId, undefined);
      assert.equal(llmCalled, false, 'no LLM spend on a refused turn');
      assert.equal(rec.insertMessage.length, 0, 'no message inserted');
      assert.equal(rec.aiCalls.length, 0, 'no spend row for a turn that never ran');
      assert.equal(rec.appendEvents.length, 0, 'no lifecycle receipts — the turn never started');

      // The claim is released through the BARE-DELETE path: reason NULL, so
      // release_conversation_turn emits NO turn.quiesced (ADR-0027 D4/D6).
      assert.equal(rec.releaseTurn.length, 1, 'the claim is still released');
      assert.equal(rec.releaseTurn[0].reason, null);
      assert.equal(rec.releaseTurn[0].produced, false);
      assert.equal(rec.releaseTurn[0].token, rec.claimTurn[0].token);

      // Explicit order: the quota gate is the FIRST thing inside the claim,
      // and the refused turn touches nothing else before releasing.
      assert.deepEqual(rec.order.slice(0, 3), ['claim', 'readAgentUsage', 'release']);

      // Metadata-only refusal receipt.
      const refused = captured.filter((c) => c.event === 'QuotaRefused');
      assert.equal(refused.length, 1);
      assert.equal(refused[0].distinctId, 'user-1');
      assert.deepEqual(refused[0].properties, {
        resource: 'agent-turns-day',
        used: 50,
        limit: 50,
        conversation_id: 'c1',
        source: 'external-agent',
      });
    } finally {
      setPostHogFlags(undefined);
    }
  });

  it('quota read fails → turn proceeds fail-open + QuotaCheckDegraded receipt', async () => {
    const { flags, captured } = makeFlags();
    setPostHogFlags(flags);
    try {
      const { client, rec } = makeClient({ usageThrows: true });
      const res = await runAgentTurn(INPUT, AUTH, {
        clientFactory: async () => client,
        llmCall: constantLlm('reply text'),
      });

      assert.equal(res.status, 'ok');
      assert.equal(res.messageId, 'm1');
      assert.equal(rec.insertMessage.length, 1, 'the turn ran despite the failed read');

      const degraded = captured.filter((c) => c.event === 'QuotaCheckDegraded');
      assert.equal(degraded.length, 1);
      assert.equal(degraded[0].distinctId, 'user-1');
      assert.deepEqual(degraded[0].properties, {
        resource: 'agent-turns-day',
        source: 'external-agent',
      });
      assert.equal(
        captured.filter((c) => c.event === 'QuotaRefused').length,
        0,
        'a failed read never refuses',
      );
    } finally {
      setPostHogFlags(undefined);
    }
  });

  it('malformed-but-ok usage row → turn proceeds + QuotaCheckDegraded (schema drift observable)', async () => {
    const { flags, captured } = makeFlags();
    setPostHogFlags(flags);
    try {
      for (const body of [null, [], [{ agent_turns_today: 99 }]]) {
        const { client } = makeClient({ usage: { ok: true, body } });
        const res = await runAgentTurn(INPUT, AUTH, {
          clientFactory: async () => client,
          llmCall: constantLlm('ok'),
        });
        assert.equal(res.status, 'ok');
      }
      const degraded = captured.filter((c) => c.event === 'QuotaCheckDegraded');
      assert.equal(degraded.length, 3, 'one receipt per malformed reply');
      assert.deepEqual(degraded[0].properties, {
        resource: 'agent-turns-day',
        source: 'external-agent',
      });
    } finally {
      setPostHogFlags(undefined);
    }
  });

  it('non-positive limit → turn proceeds WITHOUT a degraded receipt (legitimate "no limit")', async () => {
    const { flags, captured } = makeFlags();
    setPostHogFlags(flags);
    try {
      const { client } = makeClient({
        usage: { ok: true, body: [{ agent_turns_today: 99, agent_turns_limit_day: 0 }] },
      });
      const res = await runAgentTurn(INPUT, AUTH, {
        clientFactory: async () => client,
        llmCall: constantLlm('ok'),
      });
      assert.equal(res.status, 'ok');
      assert.equal(captured.filter((c) => c.event === 'QuotaCheckDegraded').length, 0);
    } finally {
      setPostHogFlags(undefined);
    }
  });

  it('success → one ai_calls spend row: source external-agent, reported tokens + model', async () => {
    const { client, rec } = makeClient();
    // An llmCall that reports usage the way real backends do (usage-context).
    const llmCall: LLMCall = async () => {
      recordLlmUsage({
        provider: 'agent-sdk',
        model: 'claude-sonnet-4-6',
        inputTokens: 120,
        outputTokens: 45,
      });
      return 'the reply';
    };

    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall,
    });

    assert.equal(res.status, 'ok');
    assert.equal(rec.aiCalls.length, 1, 'exactly one spend row per turn');
    assert.equal(rec.aiCalls[0].source, 'external-agent');
    assert.equal(rec.aiCalls[0].model, 'claude-sonnet-4-6');
    assert.equal(rec.aiCalls[0].inputTokens, 120);
    assert.equal(rec.aiCalls[0].outputTokens, 45);
    assert.ok(rec.aiCalls[0].latencyMs >= 0, 'latency is a number');
    // The ledger row lands after the LLM call, before/independent of insert.
    assert.ok(rec.order.indexOf('recordAiCall') < rec.order.indexOf('insert'));
  });

  it('success with a token-less backend → spend row with 0 tokens and unknown model', async () => {
    // The Copilot flow reports no per-call tokens: the row still counts the
    // call (the quota unit) with NOT-NULL-friendly zero token defaults.
    const { client, rec } = makeClient();
    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall: constantLlm('the reply'),
    });

    assert.equal(res.status, 'ok');
    assert.equal(rec.aiCalls.length, 1);
    assert.equal(rec.aiCalls[0].inputTokens, 0);
    assert.equal(rec.aiCalls[0].outputTokens, 0);
    assert.equal(rec.aiCalls[0].model, 'unknown');
  });

  it('ledger insert failure → turn still ok + AgentSpendRecordFailed receipt', async () => {
    const { flags, captured } = makeFlags();
    setPostHogFlags(flags);
    try {
      const { client, rec } = makeClient({ recordAiCallThrows: true });
      const res = await runAgentTurn(INPUT, AUTH, {
        clientFactory: async () => client,
        llmCall: constantLlm('the reply'),
      });

      assert.equal(res.status, 'ok', 'a failed spend record never fails the turn');
      assert.equal(res.messageId, 'm1');
      assert.equal(rec.insertMessage.length, 1);
      assert.equal(rec.releaseTurn[0].reason, 'normal');

      // Recording failure = silent unlimited is the ADR-0027 named risk: the
      // failure must be observable.
      const failed = captured.filter((c) => c.event === 'AgentSpendRecordFailed');
      assert.equal(failed.length, 1);
      assert.deepEqual(failed[0].properties, {
        resource: 'agent-turns-day',
        source: 'external-agent',
        conversation_id: 'c1',
      });
    } finally {
      setPostHogFlags(undefined);
    }
  });

  it('quota deny with no PostHog configured still refuses cleanly (capture is optional)', async () => {
    // getPostHogFlags() is undefined on stdio/unconfigured daemons — the
    // refusal path must not depend on telemetry being wired.
    const { client, rec } = makeClient({
      usage: { ok: true, body: [{ agent_turns_today: 51, agent_turns_limit_day: 50 }] },
    });
    const res = await runAgentTurn(INPUT, AUTH, {
      clientFactory: async () => client,
      llmCall: constantLlm('x'),
    });
    assert.equal(res.status, 'quota-exceeded');
    assert.equal(rec.releaseTurn[0].reason, null);
  });
});
