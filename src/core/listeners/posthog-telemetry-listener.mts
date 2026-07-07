// Telemetry forwarder: bridges a recipe run's event bus to PostHog capture.
//
// The pipeline event bus is scoped per recipe execution (ARCH-10), so there
// is no global bus to subscribe to at daemon boot; instead the boot installs
// the PostHog instance (see #lib/flags/state.mjs) and each runRecipe call
// attaches this forwarder to its own bus — same pattern as the core
// artifact-writer listener. When no PostHog is configured the forwarder is
// simply never attached.
//
// PRIVACY: only run metadata crosses the wire — recipeRunId, stepId,
// methodId, durationMs, degraded. Event payloads (which can carry prompts,
// LLM output, user content) are deliberately NOT forwarded.

import type { EventBus } from "../bus/event-bus.mjs";
import type { PostHogFlags } from "#lib/flags/posthog.mjs";

export interface AttachPostHogTelemetryOptions {
  bus: EventBus;
  flags: PostHogFlags;
  /** Session-bound user id when the daemon runs authenticated, else "daemon". */
  distinctId: string;
}

export interface PostHogTelemetryHandle {
  detach(): void;
}

export function attachPostHogTelemetry(
  options: AttachPostHogTelemetryOptions,
): PostHogTelemetryHandle {
  const subscription = options.bus
    .observe((event) => event.phase === "run-end" || event.phase === "step-error")
    .subscribe((event) => {
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
        },
      );
    });

  return {
    detach() {
      subscription.unsubscribe();
    },
  };
}
