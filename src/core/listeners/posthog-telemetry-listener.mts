// Telemetry forwarder: bridges a recipe run's event bus to PostHog capture.
//
// The pipeline event bus is scoped per recipe execution (ARCH-10), so there
// is no global bus to subscribe to at daemon boot; instead the boot installs
// the PostHog instance (see #lib/flags/state.mjs) and each runRecipe call
// attaches this forwarder to its own bus — same pattern as the core
// artifact-writer listener. When no PostHog is configured the forwarder is
// simply never attached.
//
// PRIVACY: only run metadata and numbers cross the wire — recipeRunId, stepId,
// methodId, durationMs, degraded, plus (on run-end only) LLM usage counts and
// numeric quality metrics. Event payloads are otherwise NOT forwarded; in
// particular no prompt text, LLM output, or user content — and the run-end
// extraction below forwards numbers exclusively (never string signal values).

import type { EventBus } from "../bus/event-bus.mjs";
import { type PostHogFlags, promptExperimentFlagKey } from "#lib/flags/posthog.mjs";

export interface AttachPostHogTelemetryOptions {
  bus: EventBus;
  flags: PostHogFlags;
  /** Session-bound user id when the daemon runs authenticated, else "daemon". */
  distinctId: string;
  /**
   * Prompt-experiment variant assignment for this run (strategyId → variant
   * name), as resolved by PostHogFlags.resolvePromptVariants. When non-empty,
   * each entry is forwarded as a PostHog-native `$feature/mcp-prompt-<strategyId>`
   * property so captured events attribute to their experiment/variant. Empty or
   * omitted → no `$feature/` properties (default path unchanged).
   * PRIVACY: only variant names and strategy ids — still no prompt text.
   */
  variants?: Record<string, string>;
}

export interface PostHogTelemetryHandle {
  detach(): void;
}

export function attachPostHogTelemetry(
  options: AttachPostHogTelemetryOptions,
): PostHogTelemetryHandle {
  // Pre-compute the PostHog-native experiment-attribution properties once (they
  // are constant for the run). Empty when no variants are assigned, so the
  // spread below is a no-op on the default path.
  const featureProps: Record<string, string> = {};
  for (const [strategyId, variantName] of Object.entries(options.variants ?? {})) {
    featureProps[`$feature/${promptExperimentFlagKey(strategyId)}`] = variantName;
  }

  const subscription = options.bus
    .observe((event) => event.phase === "run-end" || event.phase === "step-error")
    .subscribe((event) => {
      // On run-end only, mine the event payload for run-level performance
      // numbers: LLM usage (CP9) and numeric quality metrics (CP10). Numbers
      // only — no string signal values, no prompt/output content ever.
      const perfProps =
        event.phase === "run-end" ? extractRunEndPerfProps(event.payload) : {};
      // capture() is fire-and-forget and never throws, so a telemetry outage
      // cannot disturb the run in progress.
      options.flags.capture(
        event.phase === "run-end" ? "mcp_run_end" : "mcp_step_error",
        options.distinctId,
        {
          recipeRunId: event.recipeRunId,
          stepId: event.stepId,
          methodId: event.methodId,
          durationMs: event.durationMs,
          degraded: event.degraded,
          ...featureProps,
          ...perfProps,
        },
      );
    });

  return {
    detach() {
      subscription.unsubscribe();
    },
  };
}

/**
 * Extract PostHog properties from a run-end event's payload: LLM usage counts
 * (CP9) and per-name numeric quality metrics (CP10).
 *
 * Contract with the recipe runner: `payload` may carry
 *   { usage?: { llmCalls, inputTokens?, outputTokens? },
 *     quality?: Record<string, number> }
 * The runner already guarantees quality values are finite numbers, but this
 * function re-checks defensively — the payload field is schema-opaque, so a
 * non-number must never reach PostHog (privacy: no string signal values).
 *
 * Undefined usage fields are omitted rather than sent as undefined. Quality
 * names are sanitized for PostHog property-key safety.
 */
function extractRunEndPerfProps(payload: unknown): Record<string, number> {
  if (!payload || typeof payload !== "object") return {};
  const props: Record<string, number> = {};

  const usage = (payload as { usage?: unknown }).usage;
  if (usage && typeof usage === "object") {
    const u = usage as { llmCalls?: unknown; inputTokens?: unknown; outputTokens?: unknown };
    if (typeof u.llmCalls === "number") props.llmCalls = u.llmCalls;
    if (typeof u.inputTokens === "number") props.inputTokens = u.inputTokens;
    if (typeof u.outputTokens === "number") props.outputTokens = u.outputTokens;
  }

  const quality = (payload as { quality?: unknown }).quality;
  if (quality && typeof quality === "object") {
    for (const [name, value] of Object.entries(quality as Record<string, unknown>)) {
      // Numbers only: never forward a string/object signal value (privacy).
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      props[`quality_${sanitizePropertyName(name)}`] = value;
    }
  }

  return props;
}

/** Replace any character outside [a-zA-Z0-9_] with '_' so the assembled
 *  PostHog property key stays safe regardless of the signal name's origin. */
function sanitizePropertyName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
