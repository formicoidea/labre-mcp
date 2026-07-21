// Refuse a hosted-daemon run when the caller's labre AI budget is spent
// (ADR-0032 Decision 2, realised through the quota rather than a plan flag).
//
// WHY THIS IS NOT A "DO YOU HAVE A PLAN" CHECK. The hosted daemon spends
// labre's own provider key, so it must be reserved to whoever pays for it. The
// obvious implementation — read the subscription and refuse the unpaid — would
// put a SECOND authority on "has this user paid" next to the billing one, which
// ADR-0030 Decision 2 exists to forbid. Instead this reads the ONE budget labre
// already resolves, `get_my_ai_usage()`, and refuses when it is exhausted:
//
//   * today it bounds abuse on the real hourly token budget;
//   * at AI launch, `tokens_per_hour` resolves to 0 for the free and files
//     plans (ADR-0030 Decision 4), so the hosted daemon becomes payers-only
//     BY ITSELF — no plan predicate, no second source of truth, no edit here.
//
// It deliberately does NOT make any resolution plan-aware: that step is staged
// for launch by the billing migration (20260721120000 header), precisely so the
// existing user base is not cut off before the managed assistant ships. This
// guard only READS whatever that resolution currently returns.
//
// SCOPE — the same rule as the ledger reporter: it only bites where a caller
// JWT exists, i.e. the hosted daemon. A local/stdio run uses the user's own
// keys, costs labre nothing, and is never refused.
//
// FAIL-OPEN, the house posture (ADR-0027 Decision 3): a denial requires a
// positive, well-formed budget answer. An unreachable RPC, a malformed row or a
// non-positive limit all allow the run — availability over the guard.

import { currentLedgerJwt } from './ledger-auth-context.mjs';

/** Thrown when the caller's labre AI budget is exhausted. The daemon surfaces
 *  it as a plain refusal; it is an expected outcome, not a crash. */
export class QuotaExceededError extends Error {
  readonly code = 'quota-exceeded';
  constructor(readonly used: number, readonly limit: number) {
    super(
      `labre AI budget exhausted: ${used}/${limit} tokens this hour. ` +
        'It refills on the rolling hour; a paid AI plan raises it.',
    );
    this.name = 'QuotaExceededError';
  }
}

/** PostgREST serialises bigint aggregates as numbers OR strings depending on
 *  the path; coerce both, treat anything else as absent. */
function toNum(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Decide from a raw get_my_ai_usage() response. `true` = refuse. Pure: a
 *  denial needs a well-formed row AND a positive limit AND used >= limit;
 *  everything else allows. Mirrors labre's api/_lib/ai-usage-guard.ts. */
export function isOverBudget(body: unknown): boolean {
  const row: unknown = Array.isArray(body) ? body[0] : body;
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  const limit = toNum(r.tokens_limit_hour);
  if (limit == null || limit <= 0) return false;
  return (toNum(r.tokens_this_hour) ?? 0) >= limit;
}

/** Refuse the run when the caller is over budget. No-op without a caller JWT
 *  (stdio/local, tests) or without Supabase config. Never throws anything but
 *  QuotaExceededError. */
export async function assertQuotaOk(): Promise<void> {
  const jwt = currentLedgerJwt();
  // A lab_ API key is not a JWT: get_my_ai_usage is SECURITY INVOKER and would
  // see a null auth.uid(), so it can answer nothing meaningful. Same known gap
  // as the ledger reporter — skipped, not guessed at.
  if (!jwt || jwt.startsWith('lab_')) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return;

  let body: unknown;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_my_ai_usage`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) return; // degrade open
    body = await res.json();
  } catch {
    return; // degrade open
  }

  if (isOverBudget(body)) {
    const row = (Array.isArray(body) ? body[0] : body) as Record<
      string,
      unknown
    >;
    throw new QuotaExceededError(
      toNum(row.tokens_this_hour) ?? 0,
      toNum(row.tokens_limit_hour) ?? 0,
    );
  }
}
