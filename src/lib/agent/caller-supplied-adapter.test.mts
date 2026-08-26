import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '#lib/vendor/ai-api/agent-adapter.mjs';
import { CallerSuppliedAdapter } from './caller-supplied-adapter.mjs';

const SESSION = {
  conversationId: 'c1',
  sessionId: 's1',
  scope: 'restricted',
  writeMode: 'ask',
} as const;

async function run(adapter: CallerSuppliedAdapter) {
  const events: AgentEvent[] = [];
  const result = await adapter.sendTurn(SESSION, {}, (e) => events.push(e));
  return { events, result };
}

describe('CallerSuppliedAdapter', () => {
  it('replays a prose turn as message → turn-end, in that order', async () => {
    const { events, result } = await run(new CallerSuppliedAdapter({ text: 'hello' }));
    assert.deepEqual(events, [
      { kind: 'message', text: 'hello' },
      { kind: 'turn-end', usage: {} },
    ]);
    assert.equal(result.finishReason, 'stop');
  });

  it('emits every proposal between the prose and the end', async () => {
    const { events } = await run(
      new CallerSuppliedAdapter({
        text: 'done',
        commands: [
          { type: 'doc.create', params: { title: 'A' } },
          { type: 'nav.home' },
        ],
      }),
    );
    assert.deepEqual(
      events.map((e) => e.kind),
      ['message', 'tool-call-proposed', 'tool-call-proposed', 'turn-end'],
    );
  });

  it('emits no message event for empty or whitespace prose', async () => {
    const { events } = await run(new CallerSuppliedAdapter({ text: '   ' }));
    assert.deepEqual(events, [{ kind: 'turn-end', usage: {} }]);
  });

  it('carries the caller usage on turn-end and in the result', async () => {
    const usage = { inputTokens: 12, outputTokens: 34 };
    const { events, result } = await run(new CallerSuppliedAdapter({ text: 'x', usage }));
    assert.deepEqual(events.at(-1), { kind: 'turn-end', usage });
    assert.deepEqual(result.usage, usage);
  });

  it('createSession returns the resolved authorization unchanged', async () => {
    const adapter = new CallerSuppliedAdapter({ text: 'x' });
    // The contract forbids re-resolving authorization inside the adapter: what
    // the orchestrator pinned is what the session carries.
    assert.deepEqual(await adapter.createSession({ ...SESSION }), { ...SESSION });
  });

  it('declares no streaming and no interrupt, and cancel is a no-op twice', async () => {
    const adapter = new CallerSuppliedAdapter({ text: 'x' });
    assert.deepEqual(adapter.capabilities, { streaming: false, interrupt: false });
    await adapter.cancel();
    await adapter.cancel();
  });
});
