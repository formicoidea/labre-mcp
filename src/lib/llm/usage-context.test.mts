import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithUsageCollector, recordLlmUsage } from './usage-context.mjs';
import type { LlmUsageAggregate } from './usage-context.mjs';

describe('usage-context', () => {
  it('counts calls and sums token dimensions', async () => {
    let agg!: LlmUsageAggregate;
    await runWithUsageCollector(() => {
      recordLlmUsage({ provider: 'a', inputTokens: 10, outputTokens: 5 });
      recordLlmUsage({ provider: 'a', inputTokens: 3, outputTokens: 2 });
    }, (a) => { agg = a; });
    assert.equal(agg.llmCalls, 2);
    assert.equal(agg.inputTokens, 13);
    assert.equal(agg.outputTokens, 7);
  });

  it('leaves token sums undefined when no record carries them', async () => {
    let agg!: LlmUsageAggregate;
    await runWithUsageCollector(() => {
      recordLlmUsage({ provider: 'copilot' });
      recordLlmUsage({ provider: 'copilot' });
    }, (a) => { agg = a; });
    assert.equal(agg.llmCalls, 2);
    assert.equal(agg.inputTokens, undefined);
    assert.equal(agg.outputTokens, undefined);
  });

  it('sums only the dimension a record actually carries', async () => {
    let agg!: LlmUsageAggregate;
    await runWithUsageCollector(() => {
      recordLlmUsage({ provider: 'a', inputTokens: 4 });        // no outputTokens
      recordLlmUsage({ provider: 'a', outputTokens: 6 });       // no inputTokens
    }, (a) => { agg = a; });
    assert.equal(agg.llmCalls, 2);
    assert.equal(agg.inputTokens, 4);
    assert.equal(agg.outputTokens, 6);
  });

  it('carries the first model seen, undefined when no record names one', async () => {
    let withModel!: LlmUsageAggregate;
    await runWithUsageCollector(() => {
      recordLlmUsage({ provider: 'a', model: 'model-one', inputTokens: 1 });
      recordLlmUsage({ provider: 'a', model: 'model-two', inputTokens: 1 });
    }, (a) => { withModel = a; });
    assert.equal(withModel.model, 'model-one');

    let withoutModel!: LlmUsageAggregate;
    await runWithUsageCollector(() => {
      recordLlmUsage({ provider: 'copilot' });
    }, (a) => { withoutModel = a; });
    assert.equal(withoutModel.model, undefined);
  });

  it('is a no-op outside a collector (does not throw)', () => {
    assert.doesNotThrow(() => recordLlmUsage({ provider: 'a', inputTokens: 1 }));
  });

  it('isolates concurrent runs from each other', async () => {
    const aggs: Record<string, LlmUsageAggregate> = {};
    // Two overlapping runs; each records into its own ALS store. If isolation
    // failed, the counts/sums would cross-contaminate.
    await Promise.all([
      runWithUsageCollector(async () => {
        recordLlmUsage({ provider: 'run1', inputTokens: 100 });
        await Promise.resolve();
        recordLlmUsage({ provider: 'run1', inputTokens: 100 });
      }, (a) => { aggs.run1 = a; }),
      runWithUsageCollector(async () => {
        recordLlmUsage({ provider: 'run2', inputTokens: 1 });
        await Promise.resolve();
        recordLlmUsage({ provider: 'run2', inputTokens: 1 });
      }, (a) => { aggs.run2 = a; }),
    ]);
    assert.equal(aggs.run1.llmCalls, 2);
    assert.equal(aggs.run1.inputTokens, 200);
    assert.equal(aggs.run2.llmCalls, 2);
    assert.equal(aggs.run2.inputTokens, 2);
  });
});
