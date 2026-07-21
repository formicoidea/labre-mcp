// The caller's bearer JWT, carried from the HTTP transport down to the cost
// ledger reporter (ADR-0032 Decision 3) without threading it through every
// dispatch/run/strategy signature — the same AsyncLocalStorage idiom the usage
// collector itself uses (usage-context.mts), and lib/degradation/context.mts.
//
// Why an ALS and not the RequestContext: the RequestContext is zod-validated,
// serialised into artefacts and forwarded to telemetry — a bearer token must
// never land there. This store is transport-scoped, in-memory, and read at
// exactly one place (the reporter). It is NEVER logged and NEVER enters an
// event or an envelope.
//
// Only the HTTP daemon sets it (around dispatch, when the request carried a
// JWT). stdio callers, unit tests and the default non-instrumented path see no
// store, so the reporter that reads it is a silent no-op there — which is the
// whole point: a run with no caller JWT writes no ledger row.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ jwt: string }>();

/** Run `fn` with the caller's bearer JWT available to the ledger reporter. */
export function runWithLedgerAuth<T>(jwt: string, fn: () => T): T {
  return storage.run({ jwt }, fn);
}

/** The caller's JWT if one was set for this async context, else null (stdio,
 *  tests, lab_-key callers that never set it). */
export function currentLedgerJwt(): string | null {
  return storage.getStore()?.jwt ?? null;
}
