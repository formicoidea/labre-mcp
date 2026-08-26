// labre's metering policy, installed at the delivery seam (CH-23 / ARCH-27,
// fourth cut).
//
// These two calls used to sit INSIDE `core/recipe/recipe-runner.mts`: a
// Supabase round-trip before the first step and another after the last one,
// hard-wired into the kernel's execution path. That is what made the kernel
// un-runnable offline and tied it to labre's billing schema.
//
// Nothing about the behaviour changes by moving them here — both were already
// no-ops without a caller JWT, which is exactly the population that reaches the
// runner through an MCP tool on the hosted daemon:
//
//   * `assertQuotaOk` refuses a run whose labre AI budget is exhausted
//     (ADR-0032 Decision 2). It reads the caller's JWT from the ledger ALS the
//     HTTP transport installs; on stdio, in local dev and in lib mode there is
//     no JWT and the guard allows. Fail-open on any doubt (ADR-0027 Decision 3).
//   * `reportUsageToLedger` writes one `ai_calls` row per LLM call
//     (ADR-0032 Decision 3). Same JWT condition, best-effort inside: it never
//     throws and never blocks the run's return.
//
// What DOES change is who decides. A consumer embedding the kernel as a library
// gets neither, because it never passes this object.

import type { RunHooks } from "#core/recipe/recipe-runner.mjs";
import { assertQuotaOk } from "#lib/llm/quota-guard.mjs";
import { reportUsageToLedger } from "#lib/llm/ledger-report.mjs";

/**
 * The metering hooks every MCP tool path installs. A single shared constant,
 * not a factory: the policy is one policy, and a per-call closure would invite
 * per-call variation nobody arbitrated.
 */
export const LABRE_METERING_HOOKS: RunHooks = {
  beforeRun: assertQuotaOk,
  onUsage: (aggregate) => {
    // Fire-and-forget by contract: the runner does not await this.
    void reportUsageToLedger(aggregate.records);
  },
};
