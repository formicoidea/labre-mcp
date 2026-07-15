// External-agent whole-turn orchestrator ([A2] slice PR-MCP1, ADR-0026).
//
// This is the daemon-side conductor for ONE external-agent turn on a shared
// strategy conversation, driven per Decision 4 path 1: the mentioning sender's
// client calls the `agent.reply` tool with the sender's Supabase JWT, and the
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
// DELIBERATELY OUT OF SCOPE (this slice): a GLOBAL concurrency cap (N users =
// N intervals + N in-flight LLM calls), presence (MCP2), draw / tool-call
// proposals, streaming, and multi-round loops. The "brain" is a single-round
// prose completion — streaming and rounds are deferred (ADR-0026 non-goals).

import { randomUUID } from 'node:crypto';
import { createLLMCall } from '#lib/llm/llm-call.mjs';
import { runWithUsageCollector, type LlmUsageAggregate } from '#lib/llm/usage-context.mjs';
import { getPostHogFlags } from '#lib/flags/state.mjs';
import { agentQuotaDecision, QuotaExceededError } from './agent-quota.mjs';
import type { LLMCall } from '#types/llm.mjs';

export { QuotaExceededError } from './agent-quota.mjs';

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

export type AgentTurnStatus = 'ok' | 'busy' | 'degraded' | 'quota-exceeded';

export interface RunAgentTurnResult {
  status: AgentTurnStatus;
  /** Present only when a non-empty agent message was persisted (status 'ok'). */
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

/**
 * The minimal Supabase surface one turn needs, all acting AS the caller under
 * RLS. Abstracted (and injectable) so the orchestration is unit-testable
 * without a live Supabase — the default factory adapts supabase-js.
 */
export interface AgentTurnClient {
  /** claim_agent_turn(conv, token, ttl, turnId) → claimed? */
  claimTurn(token: string, ttlSeconds: number, turnId: string): Promise<boolean>;
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

  const clientFactory = deps.clientFactory ?? buildDefaultClientFactory();
  const llmCall = deps.llmCall ?? createLLMCall();
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const turnTimeoutMs = deps.turnTimeoutMs ?? ENV_TURN_TIMEOUT_MS;

  const client = await clientFactory(input.conversationId, auth.token);

  // The turn token is a SECRET single-flight credential — minted here, passed
  // to claim/refresh/release, NEVER logged.
  const turnToken = randomUUID();

  const claimed = await client.claimTurn(turnToken, CLAIM_TTL_SECONDS, input.turnId);
  if (!claimed) {
    // Another turn (in-app or agent) holds the conversation. No LLM call.
    return { status: 'busy' };
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
      conductTurn(input, auth, client, llmCall),
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

/**
 * The turn body inside the claim: quota gate → read thread → one LLM call →
 * best-effort receipts → persist prose. Returns the persisted message id (when
 * any). Release is the caller's responsibility (single point, on every path).
 */
async function conductTurn(
  input: RunAgentTurnInput,
  auth: AgentTurnAuth,
  client: AgentTurnClient,
  llmCall: LLMCall,
): Promise<ConductResult> {
  // Quota gate BEFORE any spend ([A3], ADR-0027 D3/D4) — same RLS client as
  // the rest of the turn. A deny throws QuotaExceededError (caught above).
  await assertAgentQuota(auth.userId, client);

  const thread = await client.readThread(THREAD_WINDOW);
  const prompt = buildPrompt(thread);

  // One LLM call, usage collected for the spend ledger. Token counts (and the
  // model id) only exist when the backend reports them through recordLlmUsage
  // — the Copilot flow reports none, in which case the row still counts the
  // call (that is the quota's unit, ADR-0027 D1).
  let usage: LlmUsageAggregate = { llmCalls: 0 };
  const llmStartedAt = Date.now();
  const raw = await runWithUsageCollector(
    () => llmCall(prompt, undefined, { systemPrompt: SYSTEM_PROMPT }),
    (aggregate) => {
      usage = aggregate;
    },
  );
  const latencyMs = Date.now() - llmStartedAt;
  const text = raw.trim();

  // Spend ledger (ADR-0027 D4.1): ONE best-effort ai_calls row under the
  // caller's JWT — this is what get_my_agent_usage() counts tomorrow, AND the
  // admin cost ledger's visibility. A failed insert must not fail the turn,
  // but it must be observable (recording failure = silent unlimited — the
  // named ADR risk), so it captures a metadata-only receipt.
  try {
    await client.recordAiCall({
      model: usage.model ?? 'unknown',
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      latencyMs,
      source: 'external-agent',
    });
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
    // Fail-closed: agent.reply is only meaningful on a Supabase-backed daemon.
    throw new Error(
      'agent.reply requires SUPABASE_URL and SUPABASE_ANON_KEY (Supabase-backed daemon)',
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
      async claimTurn(token, ttlSeconds, turnId): Promise<boolean> {
        const { data, error } = await client.rpc('claim_agent_turn', {
          p_conversation_id: conversationId,
          p_token: token,
          p_ttl_seconds: ttlSeconds,
          p_turn_id: turnId,
        });
        if (error) throw new Error(error.message);
        return data === true;
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
