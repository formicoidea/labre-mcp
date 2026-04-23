// Tests for evaluateStrategiesInParallel — the helper that powers Phase A
// parallelization in estimate-evolution.mts.
//
// The helper must:
//   1. Run entries concurrently (total time ~= max individual time, not sum).
//   2. Preserve input order in the output array.
//   3. Isolate a rejection to a single slot while other slots resolve normally.
//   4. Keep the AsyncLocalStorage collector context per async branch so
//      per-strategy degradation events do not bleed between concurrent frames.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStrategiesInParallel } from './estimate-evolution.mjs';
import { BaseStrategy } from './strategies/capacity/base-strategy.mjs';
import { DegradationCollector } from '../../lib/degradation/collector.mjs';
import { withCollector, getCurrentCollector } from '../../lib/degradation/context.mjs';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Minimal stub strategy factory — produces a class that evaluate()s after
 *  a given delay and returns a deterministic EvolutionResult. */
function makeStub(method: string, delayMs: number, opts: { error?: string; emitEvent?: boolean } = {}) {
  return class StubStrategy extends BaseStrategy {
    static get method() { return method; }
    async evaluate(_component: any) {
      await sleep(delayMs);
      if (opts.emitEvent) {
        // Exercise AsyncLocalStorage: each concurrent branch should see
        // the ambient collector that was bound by its caller.
        const c = getCurrentCollector();
        if (c) {
          c.record({
            source: `stub:${method}`,
            reason: 'stub ran',
            severity: 'info',
            recoverable: true,
          });
        }
      }
      if (opts.error) throw new Error(opts.error);
      return { evolution: 0.5, confidence: 0.9, method };
    }
  } as any;
}

describe('evaluateStrategiesInParallel', () => {
  it('runs entries concurrently (total time ~= max, not sum)', async () => {
    const entries: Array<readonly [string, any]> = [
      ['stub-a', makeStub('stub-a', 200)],
      ['stub-b', makeStub('stub-b', 300)],
      ['stub-c', makeStub('stub-c', 100)],
    ];

    const t0 = Date.now();
    const outcomes = await evaluateStrategiesInParallel(entries, { name: 'K8s' });
    const elapsed = Date.now() - t0;

    // Max individual delay is 300 ms. Sum would be 600 ms. Allow generous
    // margin for CI jitter but well below the serial total.
    assert.ok(elapsed < 500, `expected < 500ms, got ${elapsed}ms (parallel not applied?)`);
    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[0].method, 'stub-a');
    assert.equal(outcomes[0].result.evolution, 0.5);
    assert.equal(outcomes[1].method, 'stub-b');
    assert.equal(outcomes[2].method, 'stub-c');
  });

  it('preserves input order in output regardless of completion order', async () => {
    // Slowest first, fastest last — output order must still match input.
    const entries: Array<readonly [string, any]> = [
      ['slow', makeStub('slow', 200)],
      ['medium', makeStub('medium', 100)],
      ['fast', makeStub('fast', 10)],
    ];
    const outcomes = await evaluateStrategiesInParallel(entries, { name: 'K8s' });
    assert.deepEqual(outcomes.map(o => o.method), ['slow', 'medium', 'fast']);
  });

  it('records an error for a failing strategy without blocking the others', async () => {
    const entries: Array<readonly [string, any]> = [
      ['ok-1', makeStub('ok-1', 50)],
      ['boom', makeStub('boom', 20, { error: 'synthetic failure' })],
      ['ok-2', makeStub('ok-2', 30)],
    ];
    const outcomes = await evaluateStrategiesInParallel(entries, { name: 'K8s' });

    assert.equal(outcomes[0].error, undefined);
    assert.equal(outcomes[0].result.method, 'ok-1');

    assert.equal(outcomes[1].result, null);
    assert.match(outcomes[1].error ?? '', /synthetic failure/);

    assert.equal(outcomes[2].error, undefined);
    assert.equal(outcomes[2].result.method, 'ok-2');
  });

  it('routes per-strategy degradation events to the caller-bound collector', async () => {
    const collector = new DegradationCollector('test');
    const entries: Array<readonly [string, any]> = [
      ['emit-a', makeStub('emit-a', 30, { emitEvent: true })],
      ['emit-b', makeStub('emit-b', 10, { emitEvent: true })],
    ];

    await withCollector(collector, () => evaluateStrategiesInParallel(entries, { name: 'K8s' }));

    const events = collector.getEvents();
    // Both concurrent branches should have seen the same ambient collector
    // via AsyncLocalStorage and pushed their events into it.
    const sources = events.map(e => e.source).sort();
    assert.deepEqual(sources, ['stub:emit-a', 'stub:emit-b']);
  });

  it('isolates collectors between two concurrent withCollector frames', async () => {
    // Two independent "MCP invocations" run concurrently. Each has its own
    // collector. Events must not bleed between them.
    const colA = new DegradationCollector('A');
    const colB = new DegradationCollector('B');

    const entriesA: Array<readonly [string, any]> = [
      ['a1', makeStub('a1', 50, { emitEvent: true })],
      ['a2', makeStub('a2', 10, { emitEvent: true })],
    ];
    const entriesB: Array<readonly [string, any]> = [
      ['b1', makeStub('b1', 30, { emitEvent: true })],
    ];

    await Promise.all([
      withCollector(colA, () => evaluateStrategiesInParallel(entriesA, { name: 'compA' })),
      withCollector(colB, () => evaluateStrategiesInParallel(entriesB, { name: 'compB' })),
    ]);

    assert.deepEqual(
      colA.getEvents().map(e => e.source).sort(),
      ['stub:a1', 'stub:a2'],
    );
    assert.deepEqual(
      colB.getEvents().map(e => e.source),
      ['stub:b1'],
    );
  });
});
