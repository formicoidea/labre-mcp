// Module-level PostHog flags singleton, set once at daemon boot.
//
// Injection seam for the runRecipe gate: tool definitions are module
// constants (no constructor), so boot-time wiring happens through this
// setter instead of threading a new field through RequestContext (which is
// a wire schema) or the ToolRegistry. stdio and unconfigured daemons never
// call the setter, so `getPostHogFlags()` returns undefined and the gate is
// skipped with zero overhead (no dynamic import, no network).

import type { PostHogFlags } from "./posthog.mjs";

let instance: PostHogFlags | undefined;

/** Called by the daemon boot when POSTHOG_API_KEY is configured (and by tests). */
export function setPostHogFlags(flags: PostHogFlags | undefined): void {
  instance = flags;
}

/** Undefined = no PostHog configured → gating and telemetry disabled. */
export function getPostHogFlags(): PostHogFlags | undefined {
  return instance;
}
