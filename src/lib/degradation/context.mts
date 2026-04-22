// Per-invocation degradation context using Node's AsyncLocalStorage.
//
// The MCP wrapper enters a context for each tool invocation; any code in
// the resulting async call tree can reach the collector via
// `getCurrentCollector()` without having to thread it through function
// signatures.
//
// This is intentionally optional — code that runs outside an MCP
// invocation (unit tests, CLI scripts) sees `undefined` and can fall
// back to a no-op or a locally created collector.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DegradationCollector } from './collector.mjs';

const storage = new AsyncLocalStorage<DegradationCollector>();

/**
 * Run `fn` with `collector` available to every async call below it.
 * Used internally by `withMcpDegradation`.
 */
export function runWithCollector<T>(collector: DegradationCollector, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(collector, fn);
}

/**
 * Return the collector for the current async context, or `undefined`
 * when no MCP invocation is in flight.
 *
 * Callers should treat `undefined` as "no degradation tracking active"
 * — typically that means they were invoked outside the MCP server (e.g.
 * a unit test or a script) and can skip recording.
 */
export function getCurrentCollector(): DegradationCollector | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with the given collector, returning a `Promise<T>`.
 * Convenience for async callers that want a Promise back regardless of
 * whether `fn` is synchronous.
 */
export async function withCollector<T>(
  collector: DegradationCollector,
  fn: () => Promise<T> | T,
): Promise<T> {
  return await Promise.resolve(storage.run(collector, fn));
}
