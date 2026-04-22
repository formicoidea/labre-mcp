// `withMcpDegradation` — the standard wrapper every MCP tool handler MUST
// use. It creates a per-invocation collector, seeds it with any boot-time
// health-check failures relevant to the tool, executes the handler, and
// returns the result wrapped in the `Degradable<T>` envelope.
//
// See docs/technical/degradation.md for the convention.

import type { Degradable, DegradationEvent } from './types.mjs';
import { DegradationCollector } from './collector.mjs';
import { runHealthCheck, listHealthChecks } from './registry.mjs';
import { withCollector } from './context.mjs';

export interface WithMcpDegradationOptions {
  /**
   * Subset of registered health-check sources to run as a pre-flight before
   * the handler executes. Failures are seeded into the collector so the
   * handler sees them when deciding fallback paths.
   *
   * Pass `'all'` to run every registered health check. Default: no preflight.
   */
  preflight?: string[] | 'all';
}

export type McpHandler<TResult> = (collector: DegradationCollector) => Promise<TResult> | TResult;

/**
 * Wrap an MCP tool handler with the standard degradation envelope.
 *
 * Every MCP handler in `src/mcp/`, `src/work-on-evolution/`, or
 * `src/work-on-value-chain/` should be invoked through this helper so the
 * client always receives a `Degradable<T>` shape and silent fallbacks
 * become visible via `degradationEvents`.
 *
 * The handler may throw — the throw propagates to the MCP server, which
 * wraps it as a JSON-RPC error. `Degradable` is for partial degradations
 * where the tool still returns a usable result.
 */
export async function withMcpDegradation<TResult>(
  toolName: string,
  handler: McpHandler<TResult>,
  options: WithMcpDegradationOptions = {},
): Promise<Degradable<TResult>> {
  const collector = new DegradationCollector(toolName);
  await runPreflight(collector, options.preflight);
  // Make the collector available via AsyncLocalStorage so code deep in the
  // call tree (strategies, loaders, ...) can record events without having
  // to accept it as an explicit parameter.
  const result = await withCollector(collector, () => handler(collector));
  return collector.wrap(result);
}

async function runPreflight(
  collector: DegradationCollector,
  preflight: string[] | 'all' | undefined,
): Promise<void> {
  if (!preflight) return;

  const sources = preflight === 'all' ? listHealthChecks() : preflight;
  const events = await Promise.all(sources.map((s) => runHealthCheck(s)));
  for (const event of events) {
    if (event !== null) collector.record(stripTimestamp(event));
  }
}

function stripTimestamp(event: DegradationEvent): Omit<DegradationEvent, 'at'> {
  const { at: _at, ...rest } = event;
  return rest;
}
