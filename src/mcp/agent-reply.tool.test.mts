// Tool-seam tests for agent.reply: auth gating (lab_-key caller rejected — no
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

describe('agent.reply tool', () => {
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

  it('the production instance is named agent.reply and declares the input schema', () => {
    assert.equal(AGENT_REPLY_TOOL.name, 'agent.reply');
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
