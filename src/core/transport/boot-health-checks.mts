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

  // Web search (Agent SDK): needs an Anthropic credential in the environment.
  registerHealthCheck("web-search", () => {
    return process.env.ANTHROPIC_API_KEY
      ? { ready: true }
      : { ready: false, reason: "ANTHROPIC_API_KEY not set (Agent SDK web search)" };
  });
}
