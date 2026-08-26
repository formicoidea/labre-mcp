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
// identity exists, i.e. the hosted daemon. A local/stdio run uses the user's own
// keys, costs labre nothing, and is never refused.
//
// TWO IDENTITIES, ONE BUDGET. A JWT caller is measured by `get_my_ai_usage`
// below. A `lab_` API key cannot be: that function is SECURITY INVOKER and a
// key resolves no auth.uid(). Its budget is applied by labre's
// `labre_mcp.record_mcp_key_spend` instead, in the same transaction as the
// ledger insert (see ledger-report.mts), on the SAME window and the SAME
// entitlement chain. When that RPC refuses, the reporter memoises the refusal
// here and the key's next run is stopped before it spends — see
// `noteKeyBudgetDenied`.
//
// FAIL-OPEN, the house posture (ADR-0027 Decision 3): a denial requires a
// positive, well-formed budget answer. An unreachable RPC, a malformed row or a
// non-positive limit all allow the run — availability over the guard.

import { currentLedgerJwt } from './ledger-auth-context.mjs';

/** A `lab_` personal API key is not a JWT — its budget lives in the RPC. */
const API_KEY_PREFIX = 'lab_';

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

// --------------------------------------------------------- the key memo --
//
// WHY A MEMO AND NOT A READ. `get_my_ai_usage` cannot answer for a `lab_` key,
// and labre exposes no second definer RPC to read a key's budget without
// recording against it — deliberately: one door per capability. So the ONE
// authoritative budget answer a key ever gets is the one
// `record_mcp_key_spend` returns when the run's spend is reported. Remembering
// it is what turns a post-hoc meter into a pre-run gate.
//
// Bounded on purpose. The budget is a ROLLING hour, so a refusal expires by
// itself; a memo that outlived the window would ban a key whose budget had
// refilled. One minute — the same TTL the api-key auth cache uses — is short
// enough to refill promptly and long enough that a refused caller cannot spin.
// After it lapses, one run goes through, re-observes the refusal at report time
// and re-arms the memo: a bounded leak, never a lockout.
//
// In-process and per-key, like that auth cache: no shared store, nothing
// persisted, and it dies with the daemon.
const DENIAL_MEMO_MS = 60_000;

const deniedKeys = new Map<string, { until: number; used: number; limit: number }>();

/** Remember that labre refused this key's spend, with the numbers it refused
 *  on. Called by the ledger reporter — the only place that ever hears a
 *  `denied`. The key is a Map KEY, never a log line. */
export function noteKeyBudgetDenied(apiKey: string, used: number, limit: number): void {
  deniedKeys.set(apiKey, { until: Date.now() + DENIAL_MEMO_MS, used, limit });
}

/** Forget a past refusal — the budget has just answered yes for this key. */
export function forgetKeyBudgetDenial(apiKey: string): void {
  deniedKeys.delete(apiKey);
}

/** Test seam: drop every memo. */
export function resetKeyBudgetDenials(): void {
  deniedKeys.clear();
}

/** Refuse the run when the caller is over budget. No-op without a caller
 *  identity (stdio/local, tests) or without Supabase config. Never throws
 *  anything but QuotaExceededError. */
export async function assertQuotaOk(): Promise<void> {
  const jwt = currentLedgerJwt();
  if (!jwt) return;

  // A lab_ API key is not a JWT: get_my_ai_usage is SECURITY INVOKER and would
  // see a null auth.uid(). Its budget was applied by record_mcp_key_spend when
  // the previous run reported; all this guard can do — and must do — is honour
  // that answer while it is still fresh.
  if (jwt.startsWith(API_KEY_PREFIX)) {
    const memo = deniedKeys.get(jwt);
    if (!memo) return;
    if (memo.until <= Date.now()) {
      deniedKeys.delete(jwt);
      return; // degrade open: the window has moved, ask the budget again.
    }
    throw new QuotaExceededError(memo.used, memo.limit);
  }

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
