// Tool-seam tests for agentReply: auth gating (lab_-key caller rejected — no
// context.auth.token) and JWT wiring (input + auth threaded to the runner).
// The orchestration itself is covered by src/lib/conversation/agent-turn.test.mts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentReplyTool, AGENT_REPLY_TOOL, type AgentTurnRunner } from './agent-reply.tool.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { RunAgentTurnInput, AgentTurnAuth } from '#lib/conversation/agent-turn.mjs';

const BASE_CONTEXT: RequestContext = {
  projectId: 'p',
  projectRoot: '/tmp/p',
  sessionId: '33333333-3333-4333-8333-333333333333',
  domain: 'wardley',
};

const ARGS = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  sessionId: '44444444-4444-4444-8444-444444444444',
  turnId: '22222222-2222-4222-8222-222222222222',
};

interface ResultShape {
  status: string;
  messageId?: string;
  error?: string;
}

describe('agentReply tool', () => {
  it('rejects a caller without a JWT (lab_ API key path) with a clear error', async () => {
    let runnerCalled = false;
    const runner: AgentTurnRunner = async () => {
      runnerCalled = true;
      return { status: 'ok' };
    };
    const tool = buildAgentReplyTool(runner);

    // A lab_-key caller has auth.userId but NO auth.token (api-key-auth.mts
    // never threads one — a lab_ key cannot pass RLS).
    const context: RequestContext = { ...BASE_CONTEXT, auth: { userId: 'user-1' } };
    const out = (await tool.handler(ARGS, context)) as ResultShape;

    assert.equal(out.status, 'error');
    assert.match(out.error ?? '', /requires a user JWT/);
    assert.equal(runnerCalled, false, 'the runner must not be reached');
  });

  it('wires a JWT caller through: input parsed + defaults, auth threaded', async () => {
    let seenInput: RunAgentTurnInput | undefined;
    let seenAuth: AgentTurnAuth | undefined;
    const runner: AgentTurnRunner = async (input, auth) => {
      seenInput = input;
      seenAuth = auth;
      return { status: 'ok', messageId: 'm1' };
    };
    const tool = buildAgentReplyTool(runner);

    const context: RequestContext = {
      ...BASE_CONTEXT,
      auth: { userId: 'user-1', token: 'jwt-abc' },
    };
    const out = (await tool.handler(ARGS, context)) as ResultShape;

    assert.equal(out.status, 'ok');
    assert.equal(out.messageId, 'm1');
    assert.equal(seenAuth?.userId, 'user-1');
    assert.equal(seenAuth?.token, 'jwt-abc');
    assert.equal(seenInput?.conversationId, ARGS.conversationId);
    assert.equal(seenInput?.sessionId, ARGS.sessionId);
    assert.equal(seenInput?.turnId, ARGS.turnId);
    // Guest-brain defaults (ADR-0021): ask + restricted.
    assert.equal(seenInput?.writeMode, 'ask');
    assert.equal(seenInput?.scope, 'restricted');
  });

  it('relays busy/degraded/quota-exceeded statuses without a messageId', async () => {
    const context: RequestContext = {
      ...BASE_CONTEXT,
      auth: { userId: 'user-1', token: 'jwt-abc' },
    };
    for (const status of ['busy', 'degraded', 'quota-exceeded'] as const) {
      const tool = buildAgentReplyTool(async () => ({ status }));
      const out = (await tool.handler(ARGS, context)) as ResultShape;
      assert.equal(out.status, status);
      assert.equal(out.messageId, undefined);
    }
  });

  it('the tool description documents the quota-exceeded status (client contract)', () => {
    assert.match(AGENT_REPLY_TOOL.description, /"quota-exceeded"/);
  });

  // ─── Issuer-provenance gate (issue #33) ──────────────────────────────────

  it('refuses an OIDC-authenticated caller first-class, before ANY Supabase work', async () => {
    let runnerCalled = false;
    const runner: AgentTurnRunner = async () => {
      // The runner is the ONLY seam that builds the per-request Supabase
      // client — it staying uncalled proves no Supabase call was attempted.
      runnerCalled = true;
      return { status: 'ok' };
    };
    const tool = buildAgentReplyTool(runner);

    // A valid OIDC JWT at the daemon's door: userId + token present, but the
    // provenance says the token cannot mint auth.uid() against PostgREST.
    const context: RequestContext = {
      ...BASE_CONTEXT,
      auth: { userId: 'user-oidc', token: 'oidc-jwt', source: 'oidc' },
    };
    const out = (await tool.handler(ARGS, context)) as ResultShape;

    assert.equal(out.status, 'unsupported-issuer', 'a first-class status, not a generic error');
    assert.match(out.error ?? '', /Supabase-issued user JWT/);
    assert.match(out.error ?? '', /"oidc"/);
    assert.equal(runnerCalled, false, 'no Supabase call may be attempted');
  });

  it('a Supabase-provenance caller passes the gate', async () => {
    const tool = buildAgentReplyTool(async () => ({ status: 'ok', messageId: 'm2' }));
    const context: RequestContext = {
      ...BASE_CONTEXT,
      auth: { userId: 'user-1', token: 'supa-jwt', source: 'supabase' },
    };
    const out = (await tool.handler(ARGS, context)) as ResultShape;
    assert.equal(out.status, 'ok');
    assert.equal(out.messageId, 'm2');
  });

  it('an api-key caller keeps its long-standing explicit refusal (not unsupported-issuer)', async () => {
    let runnerCalled = false;
    const tool = buildAgentReplyTool(async () => {
      runnerCalled = true;
      return { status: 'ok' };
    });
    // Real lab_ callers now carry source 'api-key' and never a token.
    const context: RequestContext = {
      ...BASE_CONTEXT,
      auth: { userId: 'user-lab', source: 'api-key' },
    };
    const out = (await tool.handler(ARGS, context)) as ResultShape;
    assert.equal(out.status, 'error');
    assert.match(out.error ?? '', /requires a user JWT/);
    assert.equal(runnerCalled, false);
  });

  it('the tool description documents the unsupported-issuer status (client contract)', () => {
    assert.match(AGENT_REPLY_TOOL.description, /"unsupported-issuer"/);
  });

  it('rejects malformed input (non-uuid conversationId) before running', async () => {
    let runnerCalled = false;
    const tool = buildAgentReplyTool(async () => {
      runnerCalled = true;
      return { status: 'ok' };
    });
    const context: RequestContext = {
      ...BASE_CONTEXT,
      auth: { userId: 'user-1', token: 'jwt-abc' },
    };
    await assert.rejects(
      tool.handler({ ...ARGS, conversationId: 'not-a-uuid' }, context),
    );
    assert.equal(runnerCalled, false);
  });

  it('the production instance is named agentReply and declares the input schema', () => {
    assert.equal(AGENT_REPLY_TOOL.name, 'agentReply');
    // unknown: JSON-schema shape — narrowed for the assertion only.
    const schema = AGENT_REPLY_TOOL.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.ok(schema.properties?.conversationId);
    assert.ok(schema.properties?.sessionId);
    assert.ok(schema.properties?.turnId);
    const required = schema.required ?? [];
    assert.ok(required.includes('conversationId'));
    assert.ok(!required.includes('writeMode'), 'writeMode is defaulted, not required');
  });
});
