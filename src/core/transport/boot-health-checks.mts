// Boot-time health-check registration (AGENT.md hard rule #18).
//
// Registers a readiness check per external dependency so the daemon can report,
// at boot, which capabilities are degraded before any request arrives. These
// checks are CONFIG/ENV presence only — no network calls — so the boot stays
// fast and non-flaky. Live probing is deliberately out of scope (roadmap).
//
// `runAllHealthChecks()` (called in the daemon's main()) executes them and
// returns the not-ready ones for logging. Failures never block boot.

import { registerHealthCheck } from "#lib/degradation/index.mjs";
import { checkEnvironment as checkBigQueryEnv } from "#lib/patent/bigquery-client.mjs";
import { loadLLMConfig } from "#lib/llm/config.loader.mjs";
import { checkCopilotCliAvailable } from "#lib/llm/copilot-sdk-call.mjs";

/**
 * Register every boot health check. Idempotent (the registry overwrites by
 * source), so a double boot is harmless.
 */
export function registerBootHealthChecks(): void {
  // BigQuery (cpc-evolution strategy): needs project id + service-account creds.
  registerHealthCheck("bigquery", () => {
    const env = checkBigQueryEnv();
    return env.ready
      ? { ready: true }
      : { ready: false, reason: `missing env: ${env.missing.join(", ")}`, detail: { missing: env.missing } };
  });

  // LLM: the per-strategy provider config must load and parse.
  registerHealthCheck("llm", () => {
    try {
      loadLLMConfig();
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: (err as Error).message };
    }
  });

  // Copilot SDK: the npm SDK shells out to the Copilot CLI package at runtime.
  // Check only local package availability here; auth/network probing stays out
  // of boot so startup remains fast and deterministic.
  registerHealthCheck("copilot-sdk", () => {
    let cfg;
    try {
      cfg = loadLLMConfig();
    } catch {
      return { ready: true };
    }
    const usesCopilot = Object.values(cfg.providers).some((provider) => provider.kind === "copilot-sdk");
    if (!usesCopilot) return { ready: true };
    const cli = checkCopilotCliAvailable();
    return cli.ready
      ? { ready: true }
      : { ready: false, reason: cli.reason };
  });

  // PostHog (recipe feature flags + telemetry): config presence only. Absence
  // is degraded, never fatal — the gate fails open and telemetry stays off.
  registerHealthCheck("posthog", () => {
    return process.env.POSTHOG_API_KEY
      ? { ready: true }
      : {
          ready: false,
          reason: "POSTHOG_API_KEY not set (recipe flags fail open, telemetry disabled)",
        };
  });

  // Web search (Agent SDK): needs an Anthropic credential in the environment.
  registerHealthCheck("web-search", () => {
    return process.env.ANTHROPIC_API_KEY
      ? { ready: true }
      : { ready: false, reason: "ANTHROPIC_API_KEY not set (Agent SDK web search)" };
  });

  // Remote strategy bundles (Supabase): CONFIG presence only, no network
  // probe — the source authenticates with the caller's token at request
  // time, so there is nothing meaningful to probe at boot anyway.
  registerHealthCheck("strategy-bundles", () => {
    const mode = process.env.LABRE_AUTH;
    if (mode !== "supabase" && mode !== "multi") {
      // Local/noop/oidc-only mode: remote bundles are intentionally out of
      // play. `multi` admits Supabase JWTs too (issue #33), so it needs the
      // same config as the plain supabase mode.
      return { ready: true };
    }
    const missing: string[] = [];
    if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!process.env.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
    return missing.length === 0
      ? { ready: true }
      : {
          ready: false,
          reason: `remote strategy bundles disabled: missing env: ${missing.join(", ")}`,
          detail: { missing },
        };
  });
}
