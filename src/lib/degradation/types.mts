// Degradation framework — shared types
//
// `Degradable<T>` is the standard envelope that wraps every MCP tool result
// when an external dependency (LLM, BigQuery, web search, ...) misbehaves
// without forcing a hard failure. The framework lets tools keep returning
// a valid result while making the partial-failure visible to the client.
//
// See docs/technical/degradation.md for the full convention.

export type DegradationSeverity = 'info' | 'warning' | 'error';

/**
 * A single degradation observation captured during a tool invocation.
 *
 * Sources are short stable identifiers like 'bigquery', 'cpc-mapper',
 * 'web-search', 'llm:claude', 'llm:opencode'. They appear in MCP log
 * notifications and in the serialized result.
 */
export interface DegradationEvent {
  source: string;
  reason: string;
  severity: DegradationSeverity;
  recoverable: boolean;
  detail?: unknown;
  at: string;
}

/**
 * Standard envelope returned by every MCP tool handler.
 *
 * `result` is the tool's normal payload (possibly built from fallback values).
 * `degraded` is true as soon as at least one warning/error event was recorded.
 * `degradationEvents` lists every event in capture order for client display.
 */
export interface Degradable<T> {
  result: T;
  degraded: boolean;
  degradationEvents: DegradationEvent[];
}

/**
 * Outcome shape returned by a registered health check.
 *
 * `ready: true` means the dependency is usable. `reason`/`detail` describe
 * the failure mode when not ready (missing env vars, auth error, etc.).
 */
export interface HealthCheckOutcome {
  ready: boolean;
  reason?: string;
  detail?: unknown;
}

export type HealthCheck = () => Promise<HealthCheckOutcome> | HealthCheckOutcome;
