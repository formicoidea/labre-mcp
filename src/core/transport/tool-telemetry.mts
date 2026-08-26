// Tool-execution telemetry — invariant I7, "the execution paths are identical"
// (AI-harness audit, CH-09).
//
// WHAT WAS BROKEN. Telemetry existed on exactly ONE path: `runRecipe` attached
// the run forwarder to its own bus, so `mcp_run_end` / `mcp_step_error` only
// ever described recipe runs invoked through that one tool. `runCommand` and
// the three business tools (`estimateEvolution`, `evaluateMap`,
// `generateValueChain`) were mute, and the stdio transport never installed a
// PostHog client at all. A dashboard built on that data described a fifth of
// the surface and looked complete.
//
// WHY THIS IS CENTRAL. The fix follows the precedent already set for
// degradation (hard rule #18): enforce it ONCE, at the dispatch. Every
// `tools/call` — every tool, on both transports — emits exactly one
// `mcp_tool_call`. A tool cannot forget to be instrumented, because a tool is
// never what instruments it. The parity matrix
// (tool-telemetry-matrix.test.mts) pins the resulting table in CI.
//
// PRIVACY: metadata only, same rule as the recipe forwarder
// (core/listeners/posthog-telemetry-listener.mts) — tool name, target id,
// transport, duration, status, degraded flag. NEVER the arguments, never the
// result, and deliberately never the error MESSAGE: a Zod failure quotes the
// offending input, and the offending input is user content.
//
// A/B: none here, by arbitration. Prompt- and recipe-variant assignment stays
// on `runRecipe` (see the arbitration comment in src/mcp/run-recipe.tool.mts),
// so this event carries no `$feature/` property on any path.

import { getPostHogFlags } from "#lib/flags/state.mjs";
import type { RequestContext } from "../context/request-context.mjs";

/** Event name for one MCP tool invocation. Same `mcp_*` family as
 *  `mcp_run_end` / `mcp_step_error` / `mcp_boot`. */
export const TOOL_CALL_EVENT = "mcp_tool_call";

export type ToolCallStatus = "ok" | "error";

/** Which wire the call came in on. `unknown` covers in-process callers (tests,
 *  internal handlers) that dispatch without naming a transport. */
export type TransportLabel = "http" | "stdio" | "unknown";

export interface ToolCallTelemetry {
  /** MCP tool name, as registered (`runCommand`, `evaluateMap`, …). */
  tool: string;
  /**
   * What the call targeted: a 5-segment methodId for `runCommand`, a 3-segment
   * recipe ref for the recipe-backed tools. Bounded cardinality is the tool's
   * responsibility (see `ToolDefinition.telemetryTarget`): the value is
   * validated against the tool's own schema before it reaches here. Omitted
   * when the tool declares no target or the caller's value was invalid.
   */
  target?: string;
  transport: TransportLabel;
  durationMs: number;
  status: ToolCallStatus;
  /** True when the degradation collector recorded at least one warning/error. */
  degraded: boolean;
  distinctId: string;
}

/**
 * Distinct id for tool-level telemetry. Mirrors the recipe forwarder's rule
 * (posthog-telemetry-listener.mts): the authenticated user when the transport
 * carries one, else the constant `daemon` — stdio and local dev never
 * authenticate, and inventing an identity there would be worse than grouping
 * them. The `transport` property is what separates those populations.
 */
export function telemetryDistinctId(context: RequestContext): string {
  return context.auth?.userId ?? "daemon";
}

/**
 * Read the tool's own success/failure verdict out of its result.
 *
 * `runCommand` and `runRecipe` report failure IN BAND — they return
 * `{ status: 'error', errors: [...] }` rather than throwing (an unknown
 * methodId is a caller mistake, not a server fault). Counting those as
 * successes would make the error rate a fiction, so the wrapper reads the
 * field. Tools that signal failure by throwing are handled by the catch path.
 */
export function statusOfResult(result: unknown): ToolCallStatus {
  if (result && typeof result === "object" && (result as { status?: unknown }).status === "error") {
    return "error";
  }
  return "ok";
}

/**
 * Emit one `mcp_tool_call`. Fire-and-forget and never throws: `capture` is
 * already non-blocking, and the try/catch covers a broken or half-initialised
 * client. Inert when no PostHog is installed (local daemon / stdio with no
 * POSTHOG_API_KEY) — same fail-quiet contract as the rest of the flag module.
 */
export function captureToolCall(telemetry: ToolCallTelemetry): void {
  try {
    const flags = getPostHogFlags();
    if (!flags) return;
    const properties: Record<string, unknown> = {
      tool: telemetry.tool,
      transport: telemetry.transport,
      durationMs: telemetry.durationMs,
      status: telemetry.status,
      degraded: telemetry.degraded,
    };
    // Omitted rather than sent as null when the tool declares no target.
    if (telemetry.target !== undefined) properties.target = telemetry.target;
    flags.capture(TOOL_CALL_EVENT, telemetry.distinctId, properties);
  } catch {
    // Telemetry must never disturb the call it observes.
  }
}
