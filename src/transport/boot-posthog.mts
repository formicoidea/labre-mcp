// Shared PostHog boot, transport-agnostic (CH-09, invariant I7).
//
// Telemetry is a property of the PROCESS, not of the wire it answers on. Until
// CH-09 this selection lived inside labre-daemon.mts, so a labre-mcp launched
// over stdio — the way Claude Code and the Agent SDK actually launch it —
// installed no PostHog client: the flag singleton stayed undefined, and every
// consumer of it (the recipe forwarder, the AiCallEmitted sentinel, the
// tool-call wrapper) was silently inert on that transport. Both entrypoints now
// call the same function under the same condition: POSTHOG_API_KEY is set.
//
// Reading process.env here is the boot-time exception to hard rule #20 — this
// runs once, before any request, in the entrypoint. Nothing below the transport
// reaches for env at runtime.

import type { PostHogFlags } from "#lib/flags/posthog.mjs";

/**
 * Build the process's PostHog client, or `undefined` when POSTHOG_API_KEY is
 * not configured (no dynamic import, no network, no client — flags then fail
 * open and telemetry is inert by construction).
 *
 * `posthog-node` is imported dynamically so an unconfigured process never even
 * loads the package (see the header of #lib/flags/posthog.mjs).
 */
export async function selectPostHog(): Promise<PostHogFlags | undefined> {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return undefined;
  const { buildPostHog } = await import("#lib/flags/posthog.mjs");
  return buildPostHog({ apiKey, host: process.env.POSTHOG_HOST });
}
