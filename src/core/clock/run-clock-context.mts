// Run-scoped wall clock (AsyncLocalStorage).
//
// WHY THIS EXISTS. Invariant I3 (recipes.md) says a run is replayable: at fixed
// LLM outputs, two runs sharing a clock produce a strictly identical artefact.
// `RunClock` (recipe-runner.mts) already covers every stamp the RUNNER writes,
// and its header used to concede the hole: a timestamp a STRATEGY puts on its
// own signal (`capturedAt`) belonged to the strategy and was out of the
// runner's reach. `new Date()` therefore appeared 61 times in the mock
// strategies alone, and every one of them made a replay differ.
//
// The seam is the same one four other run-scoped concerns already use in this
// codebase (degradation collector, LLM usage collector, prompt overrides,
// ledger auth): the runner installs the value for the duration of the run, and
// code arbitrarily deep inside a step reads it without a signature change. No
// strategy has to accept a clock argument, and no `evaluate()` signature moves.
//
// SCOPE. This is a wall clock and nothing else — no run-id factory, no
// monotonic timer. `RunClock.newId` stays where it is used, in the runner.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<() => Date>();

/**
 * Install `now` as the run's wall clock for the duration of `fn`. Called once
 * per run by the recipe runner with the resolved `RunClock.now`, so a caller
 * that injects a fixed clock gets it honoured all the way down to a strategy's
 * `capturedAt`.
 */
export function runWithClock<T>(now: () => Date, fn: () => T): T {
  return storage.run(now, fn);
}

/**
 * The current run's wall clock reading.
 *
 * THE ONE FALLBACK. Outside a run — a strategy instantiated directly by a
 * lib-mode consumer or a unit test — there is no injected clock and the real
 * one is the only honest answer. This is deliberately the SINGLE place in the
 * strategy path allowed to call `new Date()`: one documented default at the
 * kernel's clock seam, instead of one per strategy where nothing can override
 * it.
 */
export function clockNow(): Date {
  const now = storage.getStore();
  return now ? now() : new Date();
}
