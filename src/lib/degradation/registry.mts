// Health-check registry for external dependencies.
//
// Tools register one health check per external dependency at boot
// (see src/mcp/mcp-server.mts). At runtime the MCP wrapper consults
// the registry to surface dependencies that are already known to be
// down before any request reaches the inner pipeline.
//
// The registry is process-global and append-only; tests reset it via
// `clearRegistry()`.

import type {
  DegradationEvent,
  HealthCheck,
  HealthCheckOutcome,
} from './types.mjs';
import { toErrorMessage } from '../errors.mjs';

const registry = new Map<string, HealthCheck>();

/**
 * Register a health check under a stable source identifier.
 *
 * Re-registering an existing source overwrites the previous check —
 * intended for tests; production code should register each source once
 * at boot.
 */
export function registerHealthCheck(source: string, check: HealthCheck): void {
  registry.set(source, check);
}

/** True if a check has been registered for this source. */
export function hasHealthCheck(source: string): boolean {
  return registry.has(source);
}

/** Names of every registered source, in insertion order. */
export function listHealthChecks(): string[] {
  return Array.from(registry.keys());
}

/** Reset the registry — exposed for tests; not part of the public API. */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * Run a single health check by source name.
 *
 * Returns `null` when the dependency is ready. Returns a `DegradationEvent`
 * (`severity: 'warning'`, `recoverable: false`) when the dependency is not
 * ready or the check itself threw. Unknown sources also return a warning
 * event so misconfigured callers do not silently no-op.
 */
export async function runHealthCheck(source: string): Promise<DegradationEvent | null> {
  const check = registry.get(source);
  if (!check) {
    return makeEvent(source, `no health check registered for "${source}"`, undefined);
  }

  let outcome: HealthCheckOutcome;
  try {
    outcome = await check();
  } catch (err) {
    return makeEvent(source, `health check threw: ${toErrorMessage(err)}`, { error: toErrorMessage(err) });
  }

  if (outcome.ready) return null;
  return makeEvent(source, outcome.reason ?? `${source} not ready`, outcome.detail);
}

/**
 * Run every registered health check in parallel and return the failing ones.
 *
 * Successful checks contribute nothing to the returned array; the result is
 * an empty array when every dependency is ready.
 */
export async function runAllHealthChecks(): Promise<DegradationEvent[]> {
  const sources = Array.from(registry.keys());
  const results = await Promise.all(sources.map((s) => runHealthCheck(s)));
  return results.filter((e): e is DegradationEvent => e !== null);
}

function makeEvent(source: string, reason: string, detail: unknown): DegradationEvent {
  return {
    source,
    reason,
    severity: 'warning',
    recoverable: false,
    detail,
    at: new Date().toISOString(),
  };
}
