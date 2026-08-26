import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '#lib/vendor/ai-api/agent-adapter.mjs';
import { ingestTurnEvents } from './ingestion.mjs';

const end: AgentEvent = { kind: 'turn-end', usage: {} };

describe('ingestTurnEvents', () => {
  it('composes the ADR-0015 parts in labre order', () => {
    const { content } = ingestTurnEvents(
      [
        { kind: 'message', text: 'the answer' },
        { kind: 'tool-call-proposed', command: { type: 'doc.create', params: { title: 'A' } } },
        end,
      ],
      { reasoning: ['first I looked'], truncated: true, docId: 'd1' },
    );
    assert.deepEqual(
      content.map((p) => p.type),
      ['ai-reasoning', 'text', 'ai-truncated', 'ai-command', 'doc-embed'],
      'the truncation marker sits with the prose it qualifies, before the ops',
    );
  });

  it('marks every proposal pending — ask mode is the external-agent floor', () => {
    const { content } = ingestTurnEvents([
      { kind: 'message', text: 'x' },
      { kind: 'tool-call-proposed', command: { type: 'nav.home' } },
      end,
    ]);
    assert.deepEqual(content.at(-1), {
      type: 'ai-command',
      command: { type: 'nav.home' },
      status: 'pending',
    });
  });

  it('refuses an unknown verb loudly instead of persisting it', () => {
    const { content, rejectedCommands } = ingestTurnEvents([
      { kind: 'message', text: 'x' },
      { kind: 'tool-call-proposed', command: { type: 'doc.deleteEverything' } },
      { kind: 'tool-call-proposed', command: { type: 'doc.rename', params: { title: 'B' } } },
      end,
    ]);
    assert.deepEqual(rejectedCommands, ['doc.deleteEverything']);
    assert.equal(content.filter((p) => p.type === 'ai-command').length, 1);
  });

  it('drops a whole trailing RUN of reasoning steps equal to the prose', () => {
    // The `while` (not `if`) case: the client-query loop makes a model repeat
    // its last sentence across rounds, and one pop would render the rest twice.
    const { content } = ingestTurnEvents([{ kind: 'message', text: 'same' }, end], {
      reasoning: ['thinking', 'same', 'same'],
    });
    assert.deepEqual(content, [
      { type: 'ai-reasoning', steps: ['thinking'] },
      { type: 'text', text: 'same' },
    ]);
  });

  it('never mutates the caller reasoning array', () => {
    const reasoning = ['same'];
    ingestTurnEvents([{ kind: 'message', text: 'same' }, end], { reasoning });
    assert.deepEqual(reasoning, ['same']);
  });

  it('collects errors without persisting them', () => {
    const { content, errors } = ingestTurnEvents([
      { kind: 'error', code: 'unavailable' },
      end,
    ]);
    assert.deepEqual(errors, ['unavailable']);
    assert.deepEqual(content, [], 'reply errors are ephemeral in labre, never a message');
  });

  it('reads usage off turn-end', () => {
    const { usage } = ingestTurnEvents([
      { kind: 'message', text: 'x' },
      { kind: 'turn-end', usage: { inputTokens: 5, outputTokens: 7 } },
    ]);
    assert.deepEqual(usage, { inputTokens: 5, outputTokens: 7 });
  });

  it('produces no content at all for an empty turn', () => {
    assert.deepEqual(ingestTurnEvents([end]).content, []);
  });
});
