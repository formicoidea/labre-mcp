// External-agent whole-turn orchestrator ([A2] slice PR-MCP1, ADR-0026).
//
// This is the daemon-side conductor for ONE external-agent turn on a shared
// strategy conversation, driven per Decision 4 path 1: the mentioning sender's
// client calls the `agentReply` tool with the sender's Supabase JWT, and the
// daemon acts AS that caller under RLS. The daemon itself holds NO privileged
// Supabase credential — every DB touch rides the caller's JWT (the same
// RLS-pass-through pattern as supabase-bundle-source.mts).
//
// Lifecycle (mutual exclusion + no-orphan guarantees, ADR-0026 Decision 4/5):
//   1. claim_agent_turn  — the external-agent single-flight claim; false → busy.
//   2. refresh_conversation_turn — a 20 s heartbeat keeps a slow turn's claim
//      fresh so it is never mistaken for a dead one and stolen mid-flight.
//   3. read the recent thread (RLS) + one bounded, tool-less LLM call.
//   4. append turn.started + turn.round-completed (best-effort receipts).
//   5. insert_agent_message — the prose, actor 'external-agent'.
//   6. release_conversation_turn('normal', produced) — the quiesce receipt.
// The whole turn is wall-clock bounded; on timeout / error / lost claim it
// still releases (reason 'interrupted', produced=false) — the claim is NEVER
// left behind, and the 60 s TTL is the backstop if even that release fails.
//
// [A3] (ADR-0027, PR-A3-2b) fills the quota seam: assertAgentQuota reads
// get_my_agent_usage() under the caller's JWT and refuses over-quota turns
// with the first-class 'quota-exceeded' status (claim released via the
// bare-delete path — no turn.quiesced for a turn that never started), and the
// success path records ONE best-effort ai_calls row (source 'external-agent')
// so the daily meter has data and the spend reaches the admin cost ledger.
//
// [A4] (ADR-0028, PR-A4-4) makes the conductor's brain SELECTABLE PER TURN:
// an optional `agentId` names a REGISTERED agent (a named LLM provider
// config). When present:
//   * claim_agent_turn is called with p_agent_id — the DB gates registration
//     (status='active'), the per-conversation invite, AND the PER-AGENT daily
//     cap IN-TRANSACTION (agent_turn_quota_ok: turns_per_day_cap → admin
//     default → 50; the labre owner floor was REMOVED from the predicate at
//     labre#231 review, commit 7864b48). The daemon does not duplicate those
//     checks; a refused claim is DIAGNOSED via list_conversation_agents and
//     mapped to the first-class statuses 'agent-revoked' /
//     'agent-not-invited' (generic 'agent-refused' when the diagnosis itself
//     fails). An active+invited agent whose claim is refused maps to 'busy' —
//     the bare-boolean claim RPC cannot distinguish the single-flight lock
//     from a per-agent-cap refusal at the gate (documented trade; either way
//     the DB refused before any spend).
//   * the [A3] labre quota gate (assertAgentQuota / get_my_agent_usage) is
//     SKIPPED — arbitrated at labre#231 review: labre quotas meter ONLY
//     labre's own provider subscription, and a registered-agent turn runs on
//     the agent OWNER's provider key. The per-agent cap at the claim gate is
//     the sole labre-side bound on this path.
//   * get_agent_provider_config(conv, claimToken) is read AT TURN START, under
//     the active claim; the secret lives in turn-scoped memory only — never
//     logged, never in events or errors (see agent-provider.mts).
//   * a provider failure (dead key 401, 429, timeout…) posts a SANITIZED
//     error notice into the conversation (insert_agent_message under the
//     still-held claim), then degrades cleanly (release 'interrupted').
//   * spend is recorded through record_agent_spend (claim-gated DEFINER: the
//     ledger row lands on the agent OWNER, never the summoner) instead of the
//     summoner-attributed insert-own ai_calls path.
// Without `agentId` the behavior is byte-for-byte the [A2]/[A3] path above —
// including the wire shape of claim_agent_turn (the 4-arg named call resolves
// through the RPC's DEFAULT NULL).
//
// DELIBERATELY OUT OF SCOPE (this slice): a GLOBAL concurrency cap (N users =
// N intervals + N in-flight LLM calls), presence (MCP2), draw / tool-call
// proposals, streaming, and multi-round loops. The "brain" is a single-round
// prose completion — streaming and rounds are deferred (ADR-0026 non-goals).
// Also out of scope: the web-side dynamic mention picker (PR-A4-3) and the
// closure of the NULL path (PR-A4-6).

import { randomUUID } from 'node:crypto';
import { createLLMCall } from '#lib/llm/llm-call.mjs';
import { runWithUsageCollector, type LlmUsageAggregate } from '#lib/llm/usage-context.mjs';
import { getPostHogFlags } from '#lib/flags/state.mjs';
import { agentQuotaDecision, QuotaExceededError } from './agent-quota.mjs';
import {
  createAgentProviderCall,
  providerErrorNotice,
  PROVIDER_CONFIG_NOTICE,
  type AgentProviderConfig,
} from './agent-provider.mjs';
import type { LLMCall } from '#types/llm.mjs';

export { QuotaExceededError } from './agent-quota.mjs';
export type { AgentProviderConfig } from './agent-provider.mjs';

// The claim TTL (seconds) the daemon renews via the heartbeat. Matches the
// in-app AI's 60 s-family single-flight TTL (ADR-0026 Decision 4).
const CLAIM_TTL_SECONDS = 60;
// Heartbeat cadence: comfortably inside the TTL so a legitimately slow turn
// never expires between beats.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
// Wall-clock bound for the entire turn. Overridable via LABRE_AGENT_TURN_
// TIMEOUT_MS (read at module load / daemon boot — the ARCH-15 top-level-config
// exception, never a request-time env read).
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
// How many recent messages seed the prompt (oldest → newest).
const THREAD_WINDOW = 30;

const ENV_TURN_TIMEOUT_MS = readTurnTimeoutMs();

function readTurnTimeoutMs(): number {
  const raw = process.env.LABRE_AGENT_TURN_TIMEOUT_MS;
  if (!raw) return DEFAULT_TURN_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid LABRE_AGENT_TURN_TIMEOUT_MS: "${raw}" (expected a positive integer of milliseconds)`,
    );
  }
  return parsed;
}

// ─── Public surface ─────────────────────────────────────────────────────────

export type AgentWriteMode = 'auto' | 'ask' | 'read-only';
export type AgentScope = 'full' | 'restricted';

export interface RunAgentTurnInput {
  conversationId: string;
  sessionId: string;
  turnId: string;
  /** ADR-0028: the REGISTERED agent conducting this turn (a named LLM provider
   *  config). Absent = the [A2] anonymous path, byte-for-byte — the daemon's
   *  default LLM, claim without p_agent_id. Present = claim gated on
   *  registration+invite+per-agent-cap in the DB (the labre quota does NOT
   *  apply — the turn runs on the owner's provider key, labre#231 review),
   *  provider config fetched per turn. */
  agentId?: string;
  /** ADR-0021 write posture. Default 'ask' — a guest brain never inherits the
   *  owner's auto. Carried for the contract; this prose-only slice proposes no
   *  writes, so it does not yet branch on it. */
  writeMode?: AgentWriteMode;
  /** ADR-0021 resolved read scope. Default 'restricted'. Carried for the
   *  contract; a single-round prose reply reads only the thread under RLS. */
  scope?: AgentScope;
}

/** The authenticated caller. `token` is the raw, verified JWT threaded by
 *  jwks-auth.mts — REQUIRED here (RLS pass-through). A lab_-key caller has no
 *  token and must be rejected before reaching this module. */
export interface AgentTurnAuth {
  userId: string;
  token: string;
}

/** 'agent-revoked' / 'agent-not-invited' / 'agent-refused' are the ADR-0028
 *  first-class refusals for a REGISTERED agent whose claim the DB refused
 *  (revoked / not invited / undiagnosable). 'agent-required' (PR-A4-6) is the
 *  refusal for a call that names NO agent at all, now that the anonymous path
 *  is retired. The web client maps any unknown non-ok status to a generic
 *  "refused", so additions here are non-breaking. */
export type AgentTurnStatus =
  | 'ok'
  | 'busy'
  | 'degraded'
  | 'quota-exceeded'
  | 'agent-revoked'
  | 'agent-not-invited'
  | 'agent-refused'
  | 'agent-required';

export interface RunAgentTurnResult {
  status: AgentTurnStatus;
  /** Present when a non-empty agent message was persisted (status 'ok'), or
   *  when a degraded agent turn posted its sanitized provider-error notice. */
  messageId?: string;
}

/** One thread message as read back under RLS (oldest → newest for prompting). */
export interface ThreadMessage {
  role: string;
  content: string;
  actor: string;
}

/** One turn's spend, destined for the ai_calls ledger (ADR-0027 D4.1).
 *  Token counts are 0 when the backend reported none (the ai_calls columns
 *  are NOT NULL default 0 — a Copilot-backed turn contributes a call count,
 *  not tokens). Numbers and a model identifier only — never prompt text. */
export interface AgentSpendRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  source: 'external-agent';
}

/** One invited-agent row as returned by list_conversation_agents (the safe
 *  columns the member lookup RPC serves; only id + status matter here). */
export interface AgentInviteRow {
  agentId: string;
  status: string;
}

/**
 * The minimal Supabase surface one turn needs, all acting AS the caller under
 * RLS. Abstracted (and injectable) so the orchestration is unit-testable
 * without a live Supabase — the default factory adapts supabase-js.
 */
export interface AgentTurnClient {
  /** claim_agent_turn(conv, token, ttl, turnId[, agentId]) → claimed?
   *  `agentId` absent keeps the legacy 4-arg wire call (the RPC's DEFAULT NULL
   *  path — [A2] byte-for-byte); present, the DB gates registration + invite +
   *  the per-agent daily cap in-transaction (ADR-0028 Decision 5, amended at
   *  labre#231 review: no labre owner floor in the predicate). */
  claimTurn(token: string, ttlSeconds: number, turnId: string, agentId?: string): Promise<boolean>;
  /** list_conversation_agents(conv) — the member-readable invite lookup (safe
   *  columns only). Used to DIAGNOSE a refused agent claim. */
  listConversationAgents(): Promise<AgentInviteRow[]>;
  /** get_agent_provider_config(conv, claimToken) — claim-gated DEFINER read of
   *  the conducting agent's provider config + decrypted secret (ADR-0028
   *  Decision 3c). The secret must stay turn-scoped: callers may hold it only
   *  for the duration of the turn and never log or persist it. */
  getProviderConfig(token: string): Promise<AgentProviderConfig>;
  /** record_agent_spend(conv, claimToken, model, tokens…) — claim-gated
   *  DEFINER ledger insert attributed to the agent's OWNER (ADR-0028
   *  Decision 6). Throws on failure — the caller swallows and captures a
   *  receipt (best-effort, same posture as recordAiCall). */
  recordAgentSpend(token: string, record: AgentSpendRecord): Promise<void>;
  /** refresh_conversation_turn(conv, token, ttl) → still-held? */
  refreshTurn(token: string, ttlSeconds: number): Promise<boolean>;
  /** release_conversation_turn(conv, token, reason, produced). `reason` NULL
   *  is the RPC's bare-delete path: a pure claim delete that emits NO
   *  turn.quiesced (20260714110000 — "p_reason IS NULL → a bare delete …
   *  emitting nothing"). Used for a quota-refused turn that never started. */
  releaseTurn(token: string, reason: string | null, produced: boolean): Promise<void>;
  /** get_my_agent_usage() under the caller's JWT (ADR-0027 D3.2). Returns the
   *  raw { ok, body } pair for the pure decision; ok=false on an RPC error.
   *  May also throw — the quota gate treats a throw like ok=false. */
  readAgentUsage(): Promise<{ ok: boolean; body: unknown }>;
  /** Insert one spend-ledger row into ai_calls under the caller's JWT
   *  (insert-own RLS; user_id defaults to auth.uid()). Throws on failure —
   *  the caller swallows and captures a receipt (best-effort, ADR-0027 D4.1). */
  recordAiCall(record: AgentSpendRecord): Promise<void>;
  /** append_conversation_events(conv, events) — best-effort receipts. */
  appendEvents(events: unknown[]): Promise<void>;
  /** insert_agent_message(conv, content, sessionId, null, null, null) → id. */
  insertMessage(content: unknown, sessionId: string): Promise<string | null>;
  /** Recent messages, oldest → newest, at most `limit`. */
  readThread(limit: number): Promise<ThreadMessage[]>;
}

/** Builds a per-request client authenticated AS the caller. Implementations
 *  must not retain the token beyond the returned client's lifetime. */
export type AgentTurnClientFactory = (
  conversationId: string,
  bearerToken: string,
) => Promise<AgentTurnClient>;

/** Injectable seams (tests). All optional — production uses the defaults. */
export interface RunAgentTurnDeps {
  clientFactory?: AgentTurnClientFactory;
  llmCall?: LLMCall;
  /** Builds the per-turn provider-backed LLMCall for a REGISTERED agent
   *  (default: createAgentProviderCall). Injectable so tests observe the
   *  config threading without real provider traffic. */
  providerCallFactory?: (config: AgentProviderConfig) => LLMCall;
  heartbeatIntervalMs?: number;
  turnTimeoutMs?: number;
}

// ─── Quota gate ([A3], ADR-0027 Decisions 3 & 4) ────────────────────────────

/**
 * Per-user quota gate, called before the (daemon-owned, daemon-billed) LLM
 * call. Reads get_my_agent_usage() through the SAME per-request RLS client
 * the turn already uses (caller's JWT — zero daemon-privileged credentials),
 * then applies the pure agentQuotaDecision. Throwing here aborts the turn
 * before any spend.
 *
 * Fail-OPEN: a failed read allows the turn AND captures a metadata-only
 * QuotaCheckDegraded receipt so the outage is observable, never silent
 * (ADR-0027 D3.3/D6). A deny throws a typed QuotaExceededError carrying
 * used/limit; runAgentTurn maps it to the 'quota-exceeded' status.
 */
export async function assertAgentQuota(userId: string, client: AgentTurnClient): Promise<void> {
  let ok = false;
  let body: unknown;
  try {
    ({ ok, body } = await client.readAgentUsage());
  } catch {
    // Unreachable RPC / broken client → treated exactly like ok=false below.
    ok = false;
  }

  const verdict = agentQuotaDecision(ok, body);
  if (verdict.decision === 'deny') {
    throw new QuotaExceededError(verdict.used, verdict.limit);
  }

  if (!ok || verdict.degraded) {
    // Fail-open, observably: a failed READ (ok=false / throw) or a MALFORMED
    // row (RPC schema drift — verdict.degraded) both proceed, but never
    // silently. Metadata only (resource + source, no content).
    getPostHogFlags()?.capture('QuotaCheckDegraded', userId, {
      resource: 'agent-turns-day',
      source: 'external-agent',
    });
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are an external collaborating agent participating in a shared strategy ' +
  'conversation alongside other people. Read the recent thread and reply as a ' +
  'concise, helpful collaborator. Prose only — no tool calls, no code fences, ' +
  'no diagrams. Keep it short and to the point.';

/**
 * Conduct one external-agent turn. Never throws for expected outcomes: a lost
 * race for the claim returns { status: 'busy' }; a timeout / LLM error / lost
 * claim returns { status: 'degraded' } after a best-effort release. Only a
 * programmer error (e.g. missing token) throws.
 */
export async function runAgentTurn(
  input: RunAgentTurnInput,
  auth: AgentTurnAuth,
  deps: RunAgentTurnDeps = {},
): Promise<RunAgentTurnResult> {
  if (!auth.token) {
    // Defence in depth — the tool handler already rejects lab_-key callers.
    throw new Error('runAgentTurn requires a user JWT (auth.token)');
  }

  // ADR-0028 PR-A4-6: the anonymous [A2] path is RETIRED. The closing
  // migration (20260718100000) refuses a claim that carries no agent id, so a
  // turn without one can no longer succeed — refuse it HERE, before building a
  // client and spending a round trip, and say WHY. Without this the caller
  // would read a bare 'busy' (the claim RPC returns a boolean and cannot
  // distinguish a refusal from the single-flight lock), i.e. exactly the
  // indistinguishable non-reply the A2 recette classed MAJOR.
  if (input.agentId == null) {
    return { status: 'agent-required' };
  }

  const clientFactory = deps.clientFactory ?? buildDefaultClientFactory();
  const llmCall = deps.llmCall ?? createLLMCall();
  const providerCallFactory = deps.providerCallFactory ?? createAgentProviderCall;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const turnTimeoutMs = deps.turnTimeoutMs ?? ENV_TURN_TIMEOUT_MS;

  const client = await clientFactory(input.conversationId, auth.token);

  // The turn token is a SECRET single-flight credential — minted here, passed
  // to claim/refresh/release, NEVER logged.
  const turnToken = randomUUID();

  const claimed = await client.claimTurn(turnToken, CLAIM_TTL_SECONDS, input.turnId, input.agentId);
  if (!claimed) {
    if (input.agentId == null) {
      // Another turn (in-app or agent) holds the conversation. No LLM call.
      return { status: 'busy' };
    }
    // ADR-0028: the DB refused the AGENT claim — diagnose which first-class
    // refusal this is (the claim RPC returns a bare boolean by design).
    return { status: await diagnoseAgentClaimRefusal(client, input.agentId) };
  }

  // From here the claim is HELD: every exit path below releases it, and both
  // timers below are cleared in the finally. A running turn legitimately keeps
  // the event loop alive (it IS in-flight request work); a settled turn must
  // leave no timer behind.
  let onClaimLost: ((err: Error) => void) | undefined;
  // Rejects if a heartbeat reports the claim is no longer ours (stolen /
  // expired) — races against the work so we abort instead of writing under a
  // claim we have lost.
  const claimLost = new Promise<never>((_resolve, reject) => {
    onClaimLost = reject;
  });
  // Swallow this promise's rejection if the work wins the race first (avoids an
  // unhandled rejection when claimLost never fires).
  claimLost.catch(() => undefined);

  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const held = await client.refreshTurn(turnToken, CLAIM_TTL_SECONDS);
        if (!held) onClaimLost?.(new Error('claim lost (heartbeat refused)'));
      } catch (err) {
        onClaimLost?.(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }, heartbeatIntervalMs);

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutTimer = setTimeout(
      () => reject(new Error(`agent turn exceeded ${turnTimeoutMs}ms`)),
      turnTimeoutMs,
    );
  });
  timeout.catch(() => undefined);

  try {
    // Race the whole body against the wall-clock bound and the lost-claim
    // signal. Whichever settles first wins; the losers' results are discarded —
    // but an in-flight LLM call still completes and is billed, and its
    // append/insert may still land if the claim survived (benign: the caller
    // is a write-member either way — the migration's forgery equivalence).
    const produced = await Promise.race([
      conductTurn(input, auth, client, { llmCall, providerCallFactory, turnToken }),
      timeout,
      claimLost,
    ]);

    // Normal completion: quiesce receipt, produced = a non-empty message landed.
    await client.releaseTurn(turnToken, 'normal', produced.messageId != null);
    return produced.messageId != null
      ? { status: 'ok', messageId: produced.messageId }
      : { status: 'ok' };
  } catch (err) {
    // Quota refusal FIRST (typed, expected outcome — not a degradation and it
    // must not invite retries). The turn never started: release through the
    // bare-delete path (reason NULL → the RPC deletes the claim and emits NO
    // turn.quiesced — ADR-0027 D4/D6: the log must not say a turn ended that
    // never began), then surface the first-class 'quota-exceeded' status.
    if (err instanceof QuotaExceededError) {
      try {
        await client.releaseTurn(turnToken, null, false);
      } catch {
        // TTL expiry is the backstop for a claim we could not release.
      }
      // Metadata-only refusal receipt (ADR-0027 D6): numbers + ids, no content.
      getPostHogFlags()?.capture('QuotaRefused', auth.userId, {
        resource: 'agent-turns-day',
        used: err.used,
        limit: err.limit,
        conversation_id: input.conversationId,
        source: 'external-agent',
      });
      return { status: 'quota-exceeded' };
    }

    // Provider failure on a REGISTERED-agent turn (ADR-0028): the sanitized
    // error notice was already posted (best-effort) under the still-held
    // claim; release 'interrupted' so the quiesce stays distinguishable from a
    // clean turn, and surface the notice's messageId when it landed.
    if (err instanceof AgentProviderError) {
      try {
        await client.releaseTurn(turnToken, 'interrupted', err.noticeMessageId != null);
      } catch {
        // Swallow — TTL expiry is the backstop for a claim we could not release.
      }
      return err.noticeMessageId != null
        ? { status: 'degraded', messageId: err.noticeMessageId }
        : { status: 'degraded' };
    }

    // Timeout, LLM failure, or a lost claim. NEVER leave the claim behind:
    // best-effort release (produced=false). If even this throws, the TTL is the
    // backstop. The error detail is not surfaced (it may reference internals).
    try {
      // 'interrupted' (not 'normal'): turn.quiesced is the only member-facing
      // signal, so a degraded turn stays distinguishable from a clean one.
      await client.releaseTurn(turnToken, 'interrupted', false);
    } catch {
      // Swallow — TTL expiry is the backstop for a claim we could not release.
    }
    return { status: 'degraded' };
  } finally {
    // Heartbeat AND the wall-clock timer are cleared on EVERY path — a settled
    // turn leaves nothing ticking.
    clearInterval(heartbeat);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

interface ConductResult {
  /** Present iff a non-empty message was persisted. */
  messageId?: string;
}

/** The per-turn wiring conductTurn needs beyond the client itself. */
interface ConductDeps {
  /** The daemon's default brain — the [A2] path (no agentId). */
  llmCall: LLMCall;
  /** Builds the provider-backed brain for a REGISTERED agent's config. */
  providerCallFactory: (config: AgentProviderConfig) => LLMCall;
  /** The claim token: get_agent_provider_config and record_agent_spend are
   *  gated on the ACTIVE claim (ADR-0028 Decisions 3c/6). Still secret. */
  turnToken: string;
}

/**
 * Thrown by conductTurn when a REGISTERED agent's provider (or its config
 * read) fails: the sanitized notice has already been posted best-effort.
 * runAgentTurn catches THIS TYPE to release 'interrupted' and return
 * 'degraded' with the notice's messageId. Carries NO provider error detail on
 * purpose — nothing here may echo response bodies, base_url, or the secret.
 */
class AgentProviderError extends Error {
  readonly noticeMessageId?: string;

  constructor(noticeMessageId?: string) {
    super('agent provider call failed');
    this.name = 'AgentProviderError';
    this.noticeMessageId = noticeMessageId;
  }
}

/**
 * Map a refused agent claim to its first-class status by reading the invite
 * list (member-readable). Best-effort diagnosis over server data:
 *   * not in the invite list → 'agent-not-invited' (covers nonexistent agents
 *     too — an unregistered agent is by construction not invited);
 *   * invited but status 'revoked' → 'agent-revoked';
 *   * invited and 'active' → 'busy' (the single-flight lock is the remaining
 *     NAMED cause; a per-agent-cap refusal at the claim gate is
 *     indistinguishable from outside the DEFINER and lands here too — the DB
 *     refused before any spend either way);
 *   * unreadable list or an unexpected status value → 'agent-refused'.
 */
async function diagnoseAgentClaimRefusal(
  client: AgentTurnClient,
  agentId: string,
): Promise<'busy' | 'agent-revoked' | 'agent-not-invited' | 'agent-refused'> {
  let invites: AgentInviteRow[];
  try {
    invites = await client.listConversationAgents();
  } catch {
    return 'agent-refused';
  }
  const row = invites.find((invite) => invite.agentId === agentId);
  if (row == null) return 'agent-not-invited';
  if (row.status === 'revoked') return 'agent-revoked';
  if (row.status === 'active') return 'busy';
  return 'agent-refused';
}

/**
 * Post the sanitized provider-failure notice into the conversation (the claim
 * is still held, so insert_agent_message accepts it), best-effort, and return
 * the typed error runAgentTurn maps to 'degraded'. The notice text is static
 * prose built from the error CLASS only — never provider bodies or secrets.
 */
async function postProviderFailureNotice(
  client: AgentTurnClient,
  sessionId: string,
  notice: string,
): Promise<AgentProviderError> {
  let noticeMessageId: string | undefined;
  try {
    const id = await client.insertMessage([{ type: 'text', text: notice }], sessionId);
    if (id != null) noticeMessageId = id;
  } catch {
    // Best-effort: a failed notice still degrades the turn cleanly.
  }
  return new AgentProviderError(noticeMessageId);
}

/**
 * The turn body inside the claim: (legacy path: quota gate) → (agent path:
 * provider config read) → read thread → one LLM call → best-effort receipts →
 * persist prose. Returns the persisted message id (when any). Release is the
 * caller's responsibility (single point, on every path).
 */
async function conductTurn(
  input: RunAgentTurnInput,
  auth: AgentTurnAuth,
  client: AgentTurnClient,
  deps: ConductDeps,
): Promise<ConductResult> {
  // LEGACY path only — quota gate BEFORE any spend ([A3], ADR-0027 D3/D4):
  // the anonymous brain runs on LABRE's provider subscription, which is what
  // labre quotas meter. A deny throws QuotaExceededError (caught above).
  //
  // REGISTERED-agent path: SKIPPED by arbitration (labre#231 review) — the
  // turn runs on the agent OWNER's provider key, so the labre quota does not
  // apply; the per-agent daily cap was already enforced IN-TRANSACTION at the
  // claim gate (agent_turn_quota_ok). An over-labre-quota summoner can still
  // conduct a registered-agent turn.
  if (input.agentId == null) {
    await assertAgentQuota(auth.userId, client);
  }

  // ADR-0028: resolve the turn's BRAIN. A registered agent's provider config
  // (incl. the decrypted secret) is read AT THE MOMENT OF THE TURN, under the
  // active claim. The config object stays local to this frame + the driver
  // closure — turn-scoped memory only.
  let llmCall = deps.llmCall;
  let providerModel: string | undefined;
  if (input.agentId != null) {
    try {
      const providerConfig = await client.getProviderConfig(deps.turnToken);
      // The DRIVER CONSTRUCTION belongs inside the same guard: the factory
      // validates the config and may THROW (requireCleanBaseUrl refuses a
      // missing, malformed, credential-carrying, non-https, or
      // query-carrying base_url). That is a CONFIG problem, not a provider
      // outage — it must post the same static config notice instead of
      // falling through to the generic catch and degrading silently.
      llmCall = deps.providerCallFactory(providerConfig);
      providerModel = providerConfig.model;
    } catch {
      // Config unreadable or invalid (revoked mid-claim, no secret
      // registered, bad base_url…): post the static config notice — neither
      // the RPC error text nor the config contents are ever echoed.
      throw await postProviderFailureNotice(client, input.sessionId, PROVIDER_CONFIG_NOTICE);
    }
  }

  const thread = await client.readThread(THREAD_WINDOW);
  const prompt = buildPrompt(thread);

  // One LLM call, usage collected for the spend ledger. Token counts (and the
  // model id) only exist when the backend reports them through recordLlmUsage
  // — the Copilot flow reports none, in which case the row still counts the
  // call (that is the quota's unit, ADR-0027 D1).
  let usage: LlmUsageAggregate = { llmCalls: 0 };
  const llmStartedAt = Date.now();
  let raw: string;
  try {
    raw = await runWithUsageCollector(
      () => llmCall(prompt, undefined, { systemPrompt: SYSTEM_PROMPT }),
      (aggregate) => {
        usage = aggregate;
      },
    );
  } catch (err) {
    // Legacy path: unchanged — the generic catch above degrades silently.
    if (input.agentId == null) throw err;
    // Agent path: a provider failure (dead key, 429, timeout…) posts a
    // SANITIZED notice into the conversation, then degrades (ADR-0028).
    throw await postProviderFailureNotice(client, input.sessionId, providerErrorNotice(err));
  }
  const latencyMs = Date.now() - llmStartedAt;
  const text = raw.trim();

  // Spend ledger, ONE best-effort row per turn. Registered agent: through the
  // claim-gated record_agent_spend DEFINER — the row lands on the agent
  // OWNER's ledger (ADR-0028 Decision 6), with the tokens the provider
  // actually reported. Legacy path: the [A3] insert-own ai_calls row under
  // the caller's JWT, unchanged. A failed insert must not fail the turn, but
  // it must be observable (recording failure = silent unlimited — the named
  // ADR risk), so it captures a metadata-only receipt.
  try {
    if (input.agentId != null) {
      await client.recordAgentSpend(deps.turnToken, {
        model: usage.model ?? providerModel ?? 'unknown',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        latencyMs,
        source: 'external-agent',
      });
    } else {
      await client.recordAiCall({
        model: usage.model ?? 'unknown',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        latencyMs,
        source: 'external-agent',
      });
    }
  } catch {
    getPostHogFlags()?.capture('AgentSpendRecordFailed', auth.userId, {
      resource: 'agent-turns-day',
      source: 'external-agent',
      conversation_id: input.conversationId,
    });
  }

  // Best-effort lifecycle receipts (ADR-0025). The active claim satisfies the
  // turn-scope requirement of append_conversation_events (actor derives to
  // 'external-agent' from the claim row); a failure here must NOT fail the turn.
  try {
    await client.appendEvents([
      { type: 'turn.started', payload: { turn_id: input.turnId, round: 0 } },
      { type: 'turn.round-completed', payload: { turn_id: input.turnId, round: 0 } },
    ]);
  } catch {
    // Receipts are best-effort; the message below is the turn's real output.
  }

  // Single-round prose: an empty completion persists nothing (produced=false).
  if (text.length === 0) return {};

  const messageId = await client.insertMessage([{ type: 'text', text }], input.sessionId);
  return messageId != null ? { messageId } : {};
}

/** Build the modest single-round prompt: the recent thread as plain lines. */
function buildPrompt(thread: ThreadMessage[]): string {
  if (thread.length === 0) {
    return 'The conversation has no prior messages yet. Introduce yourself briefly and offer to help.';
  }
  const lines = thread.map((m) => `${labelFor(m)}: ${m.content}`.trim());
  return `Recent conversation (oldest first):\n\n${lines.join('\n')}\n\nWrite your reply.`;
}

/** A readable speaker label from the message's actor / role (no ids). */
function labelFor(m: ThreadMessage): string {
  if (m.role === 'user') return 'Participant';
  if (m.actor === 'external-agent') return 'Agent (you, earlier)';
  return 'Assistant';
}

// ─── Default supabase-js client factory (RLS pass-through) ───────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

/**
 * The production factory: a short-lived supabase-js client authenticated AS the
 * caller (anon key + the caller's JWT in the Authorization header), schema
 * 'public', discarded when the turn settles. Cloned from
 * supabase-bundle-source.mts's caller-JWT pattern — same token invariants: the
 * bearer is a call parameter only, never stored on the module, never logged,
 * never kept beyond the client it authenticates.
 */
function buildDefaultClientFactory(): AgentTurnClientFactory {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Fail-closed: agentReply is only meaningful on a Supabase-backed daemon.
    throw new Error(
      'agentReply requires SUPABASE_URL and SUPABASE_ANON_KEY (Supabase-backed daemon)',
    );
  }
  const url = SUPABASE_URL;
  const anonKey = SUPABASE_ANON_KEY;

  return async (conversationId: string, bearerToken: string): Promise<AgentTurnClient> => {
    // Dynamic import: transports that never run an agent turn do not pay for
    // (or resolve) @supabase/supabase-js.
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: 'public' },
      // The caller's JWT rides every request; RLS + the SECURITY DEFINER RPCs
      // authorize. The client is discarded after the turn — the token never
      // outlives it.
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });

    return {
      async claimTurn(token, ttlSeconds, turnId, agentId): Promise<boolean> {
        // p_agent_id is OMITTED (not sent as null) when absent: the legacy
        // 4-arg named call resolves through the RPC's DEFAULT NULL, so the
        // [A2] wire shape stays byte-for-byte (ADR-0028 Transition).
        const params: Record<string, unknown> = {
          p_conversation_id: conversationId,
          p_token: token,
          p_ttl_seconds: ttlSeconds,
          p_turn_id: turnId,
        };
        if (agentId != null) params.p_agent_id = agentId;
        const { data, error } = await client.rpc('claim_agent_turn', params);
        if (error) throw new Error(error.message);
        return data === true;
      },
      async listConversationAgents(): Promise<AgentInviteRow[]> {
        const { data, error } = await client.rpc('list_conversation_agents', {
          p_conversation_id: conversationId,
        });
        if (error) throw new Error(error.message);
        // unknown: untrusted rows — narrow the two fields the diagnosis needs.
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
          agentId: typeof r.agent_id === 'string' ? r.agent_id : '',
          status: typeof r.status === 'string' ? r.status : '',
        }));
      },
      async getProviderConfig(token): Promise<AgentProviderConfig> {
        const { data, error } = await client.rpc('get_agent_provider_config', {
          p_conversation_id: conversationId,
          p_token: token,
        });
        if (error) throw new Error(error.message);
        // RETURNS TABLE → an array with the single config row. Validate the
        // shape strictly and NEVER quote row contents in errors (the row
        // carries the decrypted secret).
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        const row = rows[0];
        const provider = row?.provider;
        const model = row?.model;
        const baseUrl = row?.base_url ?? null;
        const secret = row?.secret;
        if (
          (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openai-compatible') ||
          typeof model !== 'string' ||
          model.length === 0 ||
          (baseUrl !== null && typeof baseUrl !== 'string') ||
          typeof secret !== 'string' ||
          secret.length === 0
        ) {
          throw new Error('get_agent_provider_config returned an unexpected shape');
        }
        return { provider, model, baseUrl, secret };
      },
      async recordAgentSpend(token, record): Promise<void> {
        // Claim-gated DEFINER insert; the owner is resolved through the claim
        // row server-side. p_cost_usd stays at its DEFAULT (null) — the
        // daemon does not price provider calls.
        const { error } = await client.rpc('record_agent_spend', {
          p_conversation_id: conversationId,
          p_token: token,
          p_model: record.model,
          p_input_tokens: record.inputTokens,
          p_output_tokens: record.outputTokens,
          p_latency_ms: record.latencyMs,
        });
        if (error) throw new Error(error.message);
      },
      async refreshTurn(token, ttlSeconds): Promise<boolean> {
        const { data, error } = await client.rpc('refresh_conversation_turn', {
          p_conversation_id: conversationId,
          p_token: token,
          p_ttl_seconds: ttlSeconds,
        });
        if (error) throw new Error(error.message);
        return data === true;
      },
      async releaseTurn(token, reason, produced): Promise<void> {
        // `reason` null is sent EXPLICITLY: supabase-js serializes it as JSON
        // null → SQL NULL, and release_conversation_turn's p_reason-NULL branch
        // is the bare delete that emits no turn.quiesced (20260714110000).
        const { error } = await client.rpc('release_conversation_turn', {
          p_conversation_id: conversationId,
          p_token: token,
          p_reason: reason,
          p_produced: produced,
        });
        if (error) throw new Error(error.message);
      },
      async readAgentUsage(): Promise<{ ok: boolean; body: unknown }> {
        // SECURITY INVOKER meter under the caller's JWT (ADR-0027 D3.2). An
        // RPC error maps to ok=false — the gate degrades OPEN on it.
        const { data, error } = await client.rpc('get_my_agent_usage');
        if (error) return { ok: false, body: undefined };
        return { ok: true, body: data };
      },
      async recordAiCall(record): Promise<void> {
        // Insert-own RLS covers this (user_id defaults to auth.uid()); the
        // ledger is write-only from the app side, so no .select() readback.
        const { error } = await client.from('ai_calls').insert({
          conversation_id: conversationId,
          model: record.model,
          input_tokens: record.inputTokens,
          output_tokens: record.outputTokens,
          latency_ms: record.latencyMs,
          source: record.source,
        });
        if (error) throw new Error(error.message);
      },
      async appendEvents(events): Promise<void> {
        const { error } = await client.rpc('append_conversation_events', {
          p_conversation_id: conversationId,
          p_events: events,
        });
        if (error) throw new Error(error.message);
      },
      async insertMessage(content, sessionId): Promise<string | null> {
        const { data, error } = await client.rpc('insert_agent_message', {
          p_conversation_id: conversationId,
          p_content: content,
          p_session_id: sessionId,
          p_doc_id: null,
          p_element_id: null,
          p_framework: null,
        });
        if (error) throw new Error(error.message);
        // insert_agent_message RETURNS SETOF messages → an array of rows.
        // unknown: PostgREST rows are untrusted — narrow the id field only.
        const rows = (data ?? []) as Array<{ id?: unknown }>;
        const id = rows[0]?.id;
        return typeof id === 'string' ? id : null;
      },
      async readThread(limit): Promise<ThreadMessage[]> {
        // Newest `limit` under RLS, then reversed to oldest → newest for the
        // prompt. The messages_conversation_idx (conversation_id, created_at)
        // backs the ordered scan.
        const { data, error } = await client
          .from('messages')
          .select('role,content,actor,created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (error) throw new Error(error.message);
        // unknown: untrusted rows — narrow field by field.
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        const mapped: ThreadMessage[] = rows.map((r) => ({
          role: typeof r.role === 'string' ? r.role : '',
          content: typeof r.content === 'string' ? r.content : '',
          actor: typeof r.actor === 'string' ? r.actor : '',
        }));
        return mapped.reverse();
      },
    };
  };
}
