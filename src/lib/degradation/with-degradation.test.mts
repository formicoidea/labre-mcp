// Tests for tryDegrade.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DegradationCollector } from './collector.mjs';
import { tryDegrade } from './with-degradation.mjs';

function silenceStdout(): () => void {
  const original = process.stdout.write.bind(process.stdout);
  // any: monkey-patching stdout — see collector.test.mts for the same pattern
  (process.stdout as any).write = (chunk: any, ..._args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('"notifications/')) return true;
    return original(chunk, ..._args);
  };
  return () => { (process.stdout as any).write = original; };
}

describe('tryDegrade', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = silenceStdout();
  });

  afterEach(() => {
    restore();
  });

  it('returns the function value when fn resolves', async () => {
    const c = new DegradationCollector('tool');
    const value = await tryDegrade(c, 'src', async () => 42, -1);
    assert.equal(value, 42);
    assert.equal(c.hasDegraded(), false);
  });

  it('returns the fallback and records when fn rejects', async () => {
    const c = new DegradationCollector('tool');
    const value = await tryDegrade(
      c,
      'bigquery',
      async () => { throw new Error('connection refused'); },
      'fallback',
    );
    assert.equal(value, 'fallback');
    assert.equal(c.hasDegraded(), true);
    const evt = c.getEvents()[0];
    assert.equal(evt.source, 'bigquery');
    assert.equal(evt.reason, 'connection refused');
    assert.equal(evt.recoverable, true);
  });

  it('forwards recoverable:false to recordError', async () => {
    const c = new DegradationCollector('tool');
    await tryDegrade(
      c,
      'llm',
      async () => { throw new Error('401'); },
      null,
      { recoverable: false },
    );
    assert.equal(c.getEvents()[0].recoverable, false);
  });

  it('forwards severity to recordError', async () => {
    const c = new DegradationCollector('tool');
    await tryDegrade(
      c,
      'llm',
      async () => { throw new Error('boom'); },
      null,
      { severity: 'error' },
    );
    assert.equal(c.getEvents()[0].severity, 'error');
  });

  it('handles synchronous fns that throw', async () => {
    const c = new DegradationCollector('tool');
    const value = await tryDegrade(
      c,
      'sync',
      () => { throw new Error('sync boom'); },
      'fb',
    );
    assert.equal(value, 'fb');
    assert.equal(c.getEvents()[0].reason, 'sync boom');
  });

  it('handles synchronous fns that return a value', async () => {
    const c = new DegradationCollector('tool');
    const value = await tryDegrade(c, 'sync', () => 'ok', 'fb');
    assert.equal(value, 'ok');
    assert.equal(c.hasDegraded(), false);
  });
});
