// Daily external-agent turn quota — the PURE decision half (ADR-0027,
// Decisions 3 & 4). The read lives in agent-turn.mts (get_my_agent_usage()
// under the caller's JWT); this module only decides, so it is unit-testable
// with zero I/O — the exact split labre's api/_lib/ai-usage-guard.ts
// (tokenGuardDecision) established for the hourly token budget.
//
// Degrade OPEN: a deny requires a positive, well-formed budget answer. An
// unavailable RPC (ok=false), a malformed row, or a non-positive limit all
// allow the turn — availability over the guard. What bounds the blast radius
// of fail-open: the per-conversation single-flight claim, the wall-clock turn
// timeout, and the QuotaCheckDegraded telemetry receipt captured by the
// caller (ADR-0027 Decision 6) so a silent outage stays observable.

/** The verdict. `deny` carries the numbers so the thrown QuotaExceededError
 *  (and the QuotaRefused receipt) can report used/limit without re-parsing
 *  the row — the only shape deviation from tokenGuardDecision's bare
 *  'allow' | 'deny', same fail-open semantics.
 *
 *  `degraded: true` marks an allow granted on a MALFORMED row (non-object
 *  row, limit absent/non-numeric): RPC schema drift would otherwise be a
 *  totally silent "quota never applies". NOT set for a non-positive limit (a
 *  legitimate "no limit" configuration), for a well-formed allow/deny, or for
 *  ok=false (the caller already observes a failed READ itself). The caller
 *  captures QuotaCheckDegraded on it. */
export type AgentQuotaDecision =
  | { decision: 'allow'; degraded?: true }
  | { decision: 'deny'; used: number; limit: number };

// PostgREST serializes bigint aggregates as JSON numbers or strings depending
// on the path; coerce both and treat anything unparseable as absent (same
// helper as ai-usage-guard.ts).
function toNum(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Decide the daily agent-turn quota from the raw get_my_agent_usage() reply.
 *
 * `deny` — well-formed row, `agent_turns_limit_day > 0` and
 * `agent_turns_today >= agent_turns_limit_day` (at the boundary counts as
 * over: the limit is "turns per day", so the limit-th turn is the last one).
 * `allow` — under the limit, or anything unreadable: RPC unavailable
 * (ok=false), malformed body, absent/non-numeric fields, non-positive limit.
 * A malformed-row allow carries `degraded: true` (see AgentQuotaDecision).
 * Pure — unit-tested.
 */
export function agentQuotaDecision(ok: boolean, body: unknown): AgentQuotaDecision {
  if (!ok) return { decision: 'allow' };
  const row: unknown = Array.isArray(body) ? body[0] : body;
  if (!row || typeof row !== 'object') return { decision: 'allow', degraded: true };
  const r = row as Record<string, unknown>;
  const limit = toNum(r.agent_turns_limit_day);
  if (limit == null) return { decision: 'allow', degraded: true };
  if (limit <= 0) return { decision: 'allow' };
  const used = toNum(r.agent_turns_today) ?? 0;
  return used >= limit ? { decision: 'deny', used, limit } : { decision: 'allow' };
}

/**
 * Thrown by assertAgentQuota on a deny. runAgentTurn catches THIS TYPE
 * specifically (before the generic degraded catch): a quota refusal is an
 * expected outcome with its own first-class status ('quota-exceeded'), not a
 * degradation — and it must not invite retries the way 'degraded' does.
 */
export class QuotaExceededError extends Error {
  readonly used: number;
  readonly limit: number;

  constructor(used: number, limit: number) {
    // Numbers only — never message text, tokens, or JWTs in an error message.
    super(`daily external-agent turn quota exceeded (${used}/${limit})`);
    this.name = 'QuotaExceededError';
    this.used = used;
    this.limit = limit;
  }
}
