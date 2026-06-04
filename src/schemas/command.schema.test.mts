import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandCallSchema,
  CommandResultSchema,
  JsonLabreEnvelopeSchema,
} from './command.schema.mjs';

describe('CommandCallSchema', () => {
  it('accepts a valid 5-segment command with input', () => {
    const r = CommandCallSchema.safeParse({
      command: 'render:wardley-map:owm:parse:dsl',
      input: { dsl: 'title Foo' },
    });
    assert.ok(r.success);
  });

  it('accepts an optional version suffix and metadata', () => {
    const r = CommandCallSchema.safeParse({
      command: 'wardley:map:value-chain:generate:top-down@0.1.0',
      input: { prompt: 'x' },
      metadata: { callerAgent: 'test' },
    });
    assert.ok(r.success);
  });

  it('rejects a non-5-segment (legacy) methodId', () => {
    const r = CommandCallSchema.safeParse({ command: 'write:capacity:s-curve', input: {} });
    assert.equal(r.success, false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const r = CommandCallSchema.safeParse({
      command: 'render:wardley-map:owm:parse:dsl',
      input: {},
      _context: { projectId: 'x' },
    });
    assert.equal(r.success, false);
  });
});

describe('CommandResultSchema', () => {
  const envelope = {
    context: {},
    signals: [{ name: 'certitude', value: 0.9, source: 'user-input', capturedAt: '2026-01-01T00:00:00Z' }],
    reasoning: [],
    insights: [{ text: 'ok', by: 'render:wardley-map:owm:parse:dsl', type: 'other' }],
    trace: [
      {
        command: 'render:wardley-map:owm:parse:dsl',
        stepId: 'command',
        durationMs: 3,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:00Z',
      },
    ],
    references: [],
  };

  it('validates the runner-shaped envelope', () => {
    assert.ok(JsonLabreEnvelopeSchema.safeParse(envelope).success);
  });

  it('accepts an ok result carrying the envelope', () => {
    const r = CommandResultSchema.safeParse({
      command: 'render:wardley-map:owm:parse:dsl',
      status: 'ok',
      output: { result: { components: [] }, signals: [], reasoning: [], insights: [] },
      envelope,
      metadata: { recipeRunId: 'abc', artifactPath: null, strategyUsed: 'render:wardley-map:owm:parse:dsl' },
    });
    assert.ok(r.success);
  });

  it('accepts an error result without an envelope', () => {
    const r = CommandResultSchema.safeParse({
      command: 'render:wardley-map:owm:parse:dsl',
      status: 'error',
      output: null,
      errors: ['Unknown strategy'],
    });
    assert.ok(r.success);
  });

  it('rejects an invalid status', () => {
    const r = CommandResultSchema.safeParse({
      command: 'render:wardley-map:owm:parse:dsl',
      status: 'done',
      output: null,
    });
    assert.equal(r.success, false);
  });
});
