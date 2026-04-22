// Tests for withMcpDegradation.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { withMcpDegradation } from './mcp-wrapper.mjs';
import {
  registerHealthCheck,
  clearRegistry,
} from './registry.mjs';

function silenceStdout(): () => void {
  const original = process.stdout.write.bind(process.stdout);
  // any: monkey-patching stdout for stdout-based tests
  (process.stdout as any).write = (chunk: any, ..._args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('"notifications/')) return true;
    return original(chunk, ..._args);
  };
  return () => { (process.stdout as any).write = original; };
}

describe('withMcpDegradation', () => {
  let restore: () => void;

  beforeEach(() => {
    clearRegistry();
    restore = silenceStdout();
  });

  afterEach(() => {
    restore();
    clearRegistry();
  });

  it('returns a Degradable envelope around the handler result', async () => {
    const wrapped = await withMcpDegradation('tool', async () => ({ score: 0.7 }));
    assert.deepEqual(wrapped.result, { score: 0.7 });
    assert.equal(wrapped.degraded, false);
    assert.deepEqual(wrapped.degradationEvents, []);
  });

  it('passes a collector to the handler', async () => {
    const wrapped = await withMcpDegradation('tool', async (collector) => {
      collector.record({ source: 'x', reason: 'r', severity: 'warning', recoverable: true });
      return 'ok';
    });
    assert.equal(wrapped.result, 'ok');
    assert.equal(wrapped.degraded, true);
    assert.equal(wrapped.degradationEvents.length, 1);
  });

  it('runs preflight for the named sources and seeds events', async () => {
    registerHealthCheck('bigquery', async () => ({ ready: false, reason: 'no creds' }));
    registerHealthCheck('llm', async () => ({ ready: true }));

    const wrapped = await withMcpDegradation(
      'tool',
      async () => 'result',
      { preflight: ['bigquery', 'llm'] },
    );
    assert.equal(wrapped.degraded, true);
    assert.equal(wrapped.degradationEvents.length, 1);
    assert.equal(wrapped.degradationEvents[0].source, 'bigquery');
  });

  it('preflight: "all" runs every registered check', async () => {
    registerHealthCheck('a', async () => ({ ready: false, reason: 'down a' }));
    registerHealthCheck('b', async () => ({ ready: false, reason: 'down b' }));

    const wrapped = await withMcpDegradation(
      'tool',
      async () => 1,
      { preflight: 'all' },
    );
    assert.equal(wrapped.degradationEvents.length, 2);
    const sources = wrapped.degradationEvents.map((e) => e.source).sort();
    assert.deepEqual(sources, ['a', 'b']);
  });

  it('no preflight by default — registry not touched', async () => {
    registerHealthCheck('bigquery', async () => ({ ready: false, reason: 'down' }));
    const wrapped = await withMcpDegradation('tool', async () => 1);
    assert.equal(wrapped.degraded, false);
    assert.deepEqual(wrapped.degradationEvents, []);
  });

  it('handler exceptions propagate (Degradable does not swallow throws)', async () => {
    await assert.rejects(
      () => withMcpDegradation('tool', async () => { throw new Error('boom'); }),
      /boom/,
    );
  });
});
