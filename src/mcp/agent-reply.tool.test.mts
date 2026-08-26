// The `agentReply` descriptor: its schema, its published status vocabulary, and
// the two doors it closes BEFORE any labre call is attempted. No network here —
// every case below returns without a fetch, by construction.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLedgerAuth } from '#lib/llm/ledger-auth-context.mjs';
import { AgentReplyInputSchema } from '#schemas/agent-reply.schema.mjs';
import type { AgentReplyResult } from '#lib/agent/agent-turn.mjs';
import { AGENT_REPLY_TOOL } from './agent-reply.tool.mjs';
import { buildMcpToolRegistry } from './tool-registry.mjs';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const VALID = { conversationId: CONVERSATION, agentId: AGENT, text: 'hello' };

// The handler ignores its context argument; the dispatch supplies a real one.
// any: the tool contract takes a RequestContext it does not read here
const CTX = {} as never;

const savedUrl = process.env.SUPABASE_URL;
const savedKey = process.env.SUPABASE_ANON_KEY;

afterEach(() => {
  if (savedUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = savedUrl;
  if (savedKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = savedKey;
});

describe('agentReply — the descriptor', () => {
  it('is registered on the MCP surface under a name the wire accepts', () => {
    const tool = buildMcpToolRegistry().get('agentReply');
    assert.ok(tool, 'agentReply must be part of the composed tool registry');
    // Hard rule #24b — a dot would make claude.ai reject every request of any
    // conversation including this connector. The ADRs call it `agent.reply`;
    // the WIRE name cannot.
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(!tool.name.includes('.'));
  });

  it('publishes its status vocabulary in the description, so a caller can branch', () => {
    for (const status of [
      'replied',
      'quota-exceeded',
      'agent-revoked',
      'agent-not-invited',
      'busy',
      'identity-unsupported',
      'not-configured',
      'error',
    ]) {
      assert.ok(
        AGENT_REPLY_TOOL.description.includes(status),
        `status "${status}" is not documented on the tool`,
      );
    }
  });

  it('declares no telemetry target — a conversation uuid is a cardinality leak', () => {
    assert.equal(AGENT_REPLY_TOOL.telemetryTarget, undefined);
  });

  it('exposes an object input schema over the wire', () => {
    assert.equal((AGENT_REPLY_TOOL.inputSchema as { type?: string }).type, 'object');
  });
});

describe('agentReply — the input contract', () => {
  it('accepts a minimal turn', () => {
    assert.equal(AgentReplyInputSchema.safeParse(VALID).success, true);
  });

  it('requires a conversation, an agent and prose', () => {
    for (const missing of ['conversationId', 'agentId', 'text'] as const) {
      const args: Record<string, unknown> = { ...VALID };
      delete args[missing];
      assert.equal(
        AgentReplyInputSchema.safeParse(args).success,
        false,
        `${missing} must be required`,
      );
    }
  });

  it('refuses an unknown key rather than ignoring it', () => {
    // A caller inventing `asUser` or `serviceRoleKey` must see an error: silent
    // tolerance is how an identity field gets smuggled into a conduit.
    const parsed = AgentReplyInputSchema.safeParse({ ...VALID, asUser: 'someone-else' });
    assert.equal(parsed.success, false);
  });

  it('refuses a non-uuid conversation or agent', () => {
    assert.equal(
      AgentReplyInputSchema.safeParse({ ...VALID, conversationId: 'nope' }).success,
      false,
    );
    assert.equal(AgentReplyInputSchema.safeParse({ ...VALID, agentId: 'nope' }).success, false);
  });
});

describe('agentReply — the doors it closes before touching labre', () => {
  it('refuses with a reason when no caller identity reached it (stdio, lib mode)', async () => {
    const result = (await AGENT_REPLY_TOOL.handler(VALID, CTX)) as AgentReplyResult;
    assert.equal(result.status, 'identity-unsupported');
    assert.match(result.detail ?? '', /Supabase JWT/);
    assert.equal(result.conversationId, CONVERSATION);
  });

  it('refuses a lab_ API key, explaining that it is not a JWT', async () => {
    const result = (await runWithLedgerAuth('lab_deadbeef', () =>
      AGENT_REPLY_TOOL.handler(VALID, CTX),
    )) as AgentReplyResult;
    assert.equal(result.status, 'identity-unsupported');
    assert.match(result.detail ?? '', /not a JWT/);
  });

  it('says so plainly when the daemon is not wired to a labre project', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    const result = (await runWithLedgerAuth('header.payload.signature', () =>
      AGENT_REPLY_TOOL.handler(VALID, CTX),
    )) as AgentReplyResult;
    assert.equal(result.status, 'not-configured');
  });

  it('rejects invalid input before reading any identity at all', async () => {
    await assert.rejects(() => AGENT_REPLY_TOOL.handler({ conversationId: 'x' }, CTX));
  });
});
