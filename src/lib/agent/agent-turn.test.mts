// The liaison's behaviour, proved against stubs — no network, no Supabase, no
// model. Every status of `conductAgentTurn` is reachable here, and so are the
// two invariants that would be expensive to discover in production: the claim is
// ALWAYS released once taken, and a refusal never takes a claim at all.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaExceededError } from '#lib/llm/quota-guard.mjs';
import { CallerSuppliedAdapter } from './caller-supplied-adapter.mjs';
import { conductAgentTurn } from './agent-turn.mjs';
import type { LabreConversationClient } from './labre-conversation-client.mjs';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';

interface Recorded {
  calls: string[];
  claims: Array<Record<string, unknown>>;
  inserts: Array<Record<string, unknown>>;
  spends: Array<Record<string, unknown>>;
  releases: Array<Record<string, unknown>>;
}

type Overrides = Partial<LabreConversationClient>;

function stubClient(overrides: Overrides = {}): LabreConversationClient & Recorded {
  const rec: Recorded = { calls: [], claims: [], inserts: [], spends: [], releases: [] };
  const base: LabreConversationClient = {
    async readAgentStatus() {
      rec.calls.push('readAgentStatus');
      return 'active';
    },
    async isAgentInvited() {
      rec.calls.push('isAgentInvited');
      return true;
    },
    async claimTurn(input) {
      rec.calls.push('claimTurn');
      rec.claims.push(input);
      return true;
    },
    async insertAgentMessage(input) {
      rec.calls.push('insertAgentMessage');
      rec.inserts.push(input);
      return 'msg-1';
    },
    async recordSpend(input) {
      rec.calls.push('recordSpend');
      rec.spends.push(input);
    },
    async releaseTurn(input) {
      rec.calls.push('releaseTurn');
      rec.releases.push(input);
    },
  };
  // Keep the recording wrappers when an override replaces a method.
  const merged = { ...base } as LabreConversationClient;
  for (const [key, impl] of Object.entries(overrides)) {
    // any: generic re-binding of an interface method by name
    (merged as unknown as Record<string, unknown>)[key] = async (...args: unknown[]) => {
      rec.calls.push(key);
      // any: the override's own signature is checked by Overrides
      return (impl as (...a: unknown[]) => unknown)(...args);
    };
  }
  return Object.assign(merged, rec);
}

function deps(client: LabreConversationClient, extra: Record<string, unknown> = {}) {
  let n = 0;
  return {
    client,
    adapter: new CallerSuppliedAdapter({ text: 'the reply' }),
    assertQuota: async () => {
      /* allowed */
    },
    newId: () => `id-${++n}`,
    now: () => 1000,
    ...extra,
  };
}

const INPUT = { conversationId: CONVERSATION, agentId: AGENT };

describe('conductAgentTurn — the happy path', () => {
  it('claims, inserts, records the spend and releases normally', async () => {
    const client = stubClient();
    const result = await conductAgentTurn(INPUT, deps(client));

    assert.equal(result.status, 'replied');
    assert.equal(result.messageId, 'msg-1');
    assert.deepEqual(client.calls, [
      'readAgentStatus',
      'isAgentInvited',
      'claimTurn',
      'insertAgentMessage',
      'recordSpend',
      'releaseTurn',
    ]);
    assert.deepEqual(client.releases[0], {
      conversationId: CONVERSATION,
      token: 'id-1',
      reason: 'normal',
      produced: true,
    });
  });

  it('claims with the agent id and the 60 s TTL family', async () => {
    const client = stubClient();
    await conductAgentTurn(INPUT, deps(client));
    assert.deepEqual(client.claims[0], {
      conversationId: CONVERSATION,
      token: 'id-1',
      ttlSeconds: 60,
      turnId: 'id-2',
      agentId: AGENT,
    });
  });

  it('mints a session id when the caller carries none, and honours one when it does', async () => {
    const minted = await conductAgentTurn(INPUT, deps(stubClient()));
    assert.equal(minted.sessionId, 'id-3');
    const given = await conductAgentTurn(
      { ...INPUT, sessionId: 'burst-7' },
      deps(stubClient()),
    );
    assert.equal(given.sessionId, 'burst-7');
  });

  it('records the spend under the caller model label and the claim token', async () => {
    const client = stubClient();
    await conductAgentTurn(
      { ...INPUT, model: 'claude-opus' },
      deps(client, {
        adapter: new CallerSuppliedAdapter({
          text: 'x',
          usage: { inputTokens: 10, outputTokens: 20 },
        }),
        now: (() => {
          let t = 1000;
          return () => (t += 250);
        })(),
      }),
    );
    assert.deepEqual(client.spends[0], {
      conversationId: CONVERSATION,
      token: 'id-1',
      model: 'claude-opus',
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 250,
    });
  });

  it('falls back to an honest model label rather than inventing one', async () => {
    const client = stubClient();
    await conductAgentTurn(INPUT, deps(client));
    assert.equal(client.spends[0].model, 'external-agent');
  });

  it('persists the composed parts, ask-mode pending, through insert_agent_message', async () => {
    const client = stubClient();
    await conductAgentTurn(
      { ...INPUT, docId: '33333333-3333-4333-8333-333333333333' },
      deps(client, {
        adapter: new CallerSuppliedAdapter({
          text: 'here',
          commands: [{ type: 'doc.rename', params: { title: 'B' } }],
        }),
      }),
    );
    const content = client.inserts[0].content as Array<{ type: string; status?: string }>;
    assert.deepEqual(
      content.map((p) => p.type),
      ['text', 'ai-command', 'doc-embed'],
    );
    assert.equal(content[1].status, 'pending');
  });

  it('pins the ADR-0021 guest floor: restricted scope, ask mode, taken from no input', async () => {
    let seen: unknown;
    const adapter = new CallerSuppliedAdapter({ text: 'x' });
    const spy = {
      capabilities: adapter.capabilities,
      async createSession(input: unknown) {
        seen = input;
        // any: forwarding the contract input verbatim
        return adapter.createSession(input as Parameters<typeof adapter.createSession>[0]);
      },
      sendTurn: adapter.sendTurn.bind(adapter),
      cancel: adapter.cancel.bind(adapter),
    };
    await conductAgentTurn(INPUT, deps(stubClient(), { adapter: spy }));
    assert.deepEqual(seen, {
      conversationId: CONVERSATION,
      sessionId: 'id-3',
      scope: 'restricted',
      writeMode: 'ask',
    });
  });
});

describe('conductAgentTurn — refusals never take a claim', () => {
  it('quota-exceeded comes back as a status, with used/limit, and claims nothing', async () => {
    const client = stubClient();
    const result = await conductAgentTurn(
      INPUT,
      deps(client, {
        assertQuota: async () => {
          throw new QuotaExceededError(400, 300);
        },
      }),
    );
    assert.equal(result.status, 'quota-exceeded');
    assert.deepEqual(result.quota, { used: 400, limit: 300 });
    assert.deepEqual(client.calls, [], 'a refused turn never starts, so nothing is claimed');
  });

  it('a quota guard that fails for another reason lets the turn through (fail-open)', async () => {
    const client = stubClient();
    const result = await conductAgentTurn(
      INPUT,
      deps(client, {
        assertQuota: async () => {
          throw new Error('supabase unreachable');
        },
      }),
    );
    assert.equal(result.status, 'replied');
  });

  it('names a revoked agent instead of returning an opaque busy', async () => {
    const client = stubClient({ readAgentStatus: async () => 'revoked' });
    const result = await conductAgentTurn(INPUT, deps(client));
    assert.equal(result.status, 'agent-revoked');
    assert.ok(!client.calls.includes('claimTurn'));
  });

  it('names an unregistered / invisible agent the same way', async () => {
    const client = stubClient({ readAgentStatus: async () => null });
    const result = await conductAgentTurn(INPUT, deps(client));
    assert.equal(result.status, 'agent-revoked');
    assert.match(result.detail ?? '', /not registered/);
  });

  it('names an uninvited agent', async () => {
    const client = stubClient({ isAgentInvited: async () => false });
    const result = await conductAgentTurn(INPUT, deps(client));
    assert.equal(result.status, 'agent-not-invited');
    assert.ok(!client.calls.includes('claimTurn'));
  });

  it('a pre-check that throws is advisory: the claim still decides', async () => {
    const client = stubClient({
      readAgentStatus: async () => {
        throw new Error('PostgREST 503');
      },
    });
    const result = await conductAgentTurn(INPUT, deps(client));
    assert.equal(result.status, 'replied');
  });

  it('a refused claim is busy, and releases nothing it never held', async () => {
    const client = stubClient({ claimTurn: async () => false });
    const result = await conductAgentTurn(INPUT, deps(client));
    assert.equal(result.status, 'busy');
    assert.equal(result.turnId, 'id-2');
    assert.ok(!client.calls.includes('releaseTurn'));
  });
});

describe('conductAgentTurn — no orphan turn', () => {
  it('releases with interrupted when the insert is refused', async () => {
    const client = stubClient({
      insertAgentMessage: async () => {
        throw new Error('agent is revoked or unregistered');
      },
    });
    const result = await conductAgentTurn(INPUT, deps(client));
    assert.equal(result.status, 'error');
    assert.deepEqual(client.releases[0], {
      conversationId: CONVERSATION,
      token: 'id-1',
      reason: 'interrupted',
      produced: false,
    });
  });

  it('releases with interrupted, produced=false, when the turn produced nothing', async () => {
    const client = stubClient();
    const result = await conductAgentTurn(
      INPUT,
      deps(client, { adapter: new CallerSuppliedAdapter({ text: '   ' }) }),
    );
    assert.equal(result.status, 'error');
    assert.match(result.detail ?? '', /nothing to persist/);
    assert.equal(client.releases[0].produced, false);
    assert.ok(!client.calls.includes('insertAgentMessage'));
  });

  it('cancels the adapter on the way out of a failure', async () => {
    let cancelled = 0;
    const adapter = new CallerSuppliedAdapter({ text: 'x' });
    const spy = {
      capabilities: adapter.capabilities,
      createSession: adapter.createSession.bind(adapter),
      async sendTurn(): Promise<never> {
        throw new Error('boom');
      },
      async cancel() {
        cancelled += 1;
      },
    };
    const client = stubClient();
    const result = await conductAgentTurn(INPUT, deps(client, { adapter: spy }));
    assert.equal(result.status, 'error');
    assert.equal(cancelled, 1);
    assert.equal(client.releases[0].reason, 'interrupted');
  });

  it('a ledger failure never fails the turn it measured', async () => {
    const client = stubClient({
      recordSpend: async () => {
        throw new Error('ai_calls RLS');
      },
    });
    const result = await conductAgentTurn(INPUT, deps(client));
    assert.equal(result.status, 'replied');
    assert.equal(client.releases[0].reason, 'normal');
  });

  it('a release failure never masks the real outcome', async () => {
    const client = stubClient({
      releaseTurn: async () => {
        throw new Error('PostgREST 500');
      },
    });
    const result = await conductAgentTurn(INPUT, deps(client));
    assert.equal(result.status, 'replied');
  });

  it('reports rejected proposals on an otherwise successful turn', async () => {
    const client = stubClient();
    const result = await conductAgentTurn(
      INPUT,
      deps(client, {
        adapter: new CallerSuppliedAdapter({
          text: 'ok',
          commands: [{ type: 'doc.nuke' }],
        }),
      }),
    );
    assert.equal(result.status, 'replied');
    assert.deepEqual(result.rejectedCommands, ['doc.nuke']);
  });
});
