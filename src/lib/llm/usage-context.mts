// Per-run LLM usage collection using Node's AsyncLocalStorage.
//
// The recipe runner enters a collector for the duration of one run; any LLM
// call reachable from the run tree (via the provider factories) reports its
// token usage through `recordLlmUsage(record)` without threading a collector
// through every LLMCall/strategy signature.
//
// Same idiom as lib/degradation/context.mts and lib/prompts/override-context.mts:
// the store is optional. Code that runs outside a collector (unit tests, CLI
// scripts, the default non-instrumented path) sees no collector and
// `recordLlmUsage` is a silent no-op.
//
// PRIVACY: this collector carries ONLY numbers and provider/model identifiers —
// never prompt text or model output.

import { AsyncLocalStorage } from 'node:async_hooks';

/** One LLM call's usage, as reported by the provider that made it. Token
 *  fields are optional: some backends (e.g. the Copilot SDK single-turn flow)
 *  expose no per-call token counts, in which case only the call itself is
 *  counted. */
export interface LlmUsageRecord {
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Aggregate read back by the collector's creator at run-end.
 *  `llmCalls` is always present (a plain count). Token sums are only defined
 *  when at least one record carried that dimension — we never fabricate a 0 for
 *  providers that report nothing, so the caller can distinguish "0 tokens" from
 *  "no token data". `model` is the FIRST model identifier any record carried
 *  (undefined when none did) — enough for single-call collectors like the
 *  agent-turn spend ledger, which needs a model name for its ai_calls row. */
export interface LlmUsageAggregate {
  llmCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

/** Mutable per-run accumulator held in the ALS store. */
interface UsageCollector {
  llmCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

const storage = new AsyncLocalStorage<UsageCollector>();

/**
 * Run `fn` inside a fresh usage collector, then invoke `onAggregate` with the
 * accumulated totals. Any `recordLlmUsage` call reachable from `fn`'s async
 * tree folds into this collector. Concurrent runs each get their own store, so
 * their usage never bleeds across (AsyncLocalStorage isolation).
 *
 * The aggregate is delivered via a callback (rather than merged into the return
 * value) so callers can keep `fn`'s own return type untouched.
 */
export async function runWithUsageCollector<T>(
  fn: () => Promise<T> | T,
  onAggregate: (aggregate: LlmUsageAggregate) => void,
): Promise<T> {
  const collector: UsageCollector = { llmCalls: 0 };
  try {
    return await Promise.resolve(storage.run(collector, fn));
  } finally {
    // Snapshot into the public aggregate shape. Token sums stay undefined when
    // no record ever carried them.
    const aggregate: LlmUsageAggregate = { llmCalls: collector.llmCalls };
    if (collector.inputTokens !== undefined) aggregate.inputTokens = collector.inputTokens;
    if (collector.outputTokens !== undefined) aggregate.outputTokens = collector.outputTokens;
    if (collector.model !== undefined) aggregate.model = collector.model;
    onAggregate(aggregate);
  }
}

/**
 * Record one LLM call's usage into the current run's collector. No-op when
 * called outside a `runWithUsageCollector` scope (the default path).
 *
 * Every call increments `llmCalls`. `inputTokens`/`outputTokens` are summed
 * only from records that actually carry them — the first record with a given
 * dimension lifts that sum from undefined to a number.
 */
export function recordLlmUsage(record: LlmUsageRecord): void {
  const collector = storage.getStore();
  if (!collector) return; // outside a collector: silent no-op
  collector.llmCalls += 1;
  if (typeof record.inputTokens === 'number') {
    collector.inputTokens = (collector.inputTokens ?? 0) + record.inputTokens;
  }
  if (typeof record.outputTokens === 'number') {
    collector.outputTokens = (collector.outputTokens ?? 0) + record.outputTokens;
  }
  // First model seen wins (an aggregate has one model slot; multi-model runs
  // keep the first — the single-call collectors this serves never mix models).
  if (collector.model === undefined && typeof record.model === 'string') {
    collector.model = record.model;
  }
}
