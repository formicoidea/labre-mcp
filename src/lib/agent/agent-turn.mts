// The liaison itself: ONE bounded turn of a labre conversation, conducted by
// the MCP caller (ARCH-30; ADR-0026 [A2], Decisions 3/4/5).
//
// THE SHAPE OF A TURN, and why it is in this order:
//
//   1. QUOTA, at sendTurn.        ADR-0026 Decision 4 puts the quota gate "at
//      sendTurn, daemon-side, keyed on user_id", and ADR-0027 Decision 4 says a
//      refusal is a first-class RESULT STATUS, never a JSON-RPC error — "the
//      orchestrator's contract is 'never throws for expected outcomes'". It runs
//      BEFORE the claim, which is a deliberate improvement on ADR-0027's own
//      sketch: that one claimed first and then released through the bare-delete
//      path specifically to avoid appending a `turn.quiesced` for a turn that
//      never started. Guarding first makes the special case disappear — no claim
//      is taken, so there is nothing to release and no event to suppress. The
//      DB's own in-transaction per-agent cap still runs inside the claim.
//   2. PRE-CHECKS, so a refusal has a reason.  `claim_agent_turn` answers a bare
//      boolean, and it can be false for four different reasons. Two of them are
//      readable under the caller's own JWT (the agent's status; the invite row),
//      so they are read first and named. What is left over is genuinely 'busy'.
//      These reads are ADVISORY: they never grant anything, and if they fail the
//      turn proceeds to the claim, which is the actual gate.
//   3. CLAIM.                     The same per-conversation single-flight row the
//      in-app AI takes — one conversation, one running turn, whoever conducts.
//   4. THE ADAPTER.               `createSession` + `sendTurn` through the
//      `AgentAdapter` contract, pinned to the ADR-0021 guest floor.
//   5. INGESTION → INSERT.        The normalized events become one assistant
//      message through `insert_agent_message`.
//   6. SPEND.                     One `record_agent_spend` row on the EXISTING
//      agent ledger path — no second ledger (ADR-0028 Decision 6).
//   7. RELEASE, always.           ADR-0026 Decision 5: a disconnect MUST leave no
//      orphan turn. Every exit past the claim releases with an explicit reason,
//      so the conversation log always records how the turn ended.
//
// THE WRITE POSTURE IS NOT NEGOTIABLE HERE. Scope `restricted`, write mode
// `ask`: ADR-0026 Decision 3 makes that the external-agent default "regardless
// of the conversation's ai_write_mode — a guest brain does not inherit the
// owner's auto". ADR-0028's 2026-07-18 amendment (Decision B) lifts a PERSONAL
// LLM off that floor, and deliberately not this: that amendment's subject is the
// owner's own provider called from `reply.ts`, whose whole argument is "the owner
// registered it, the owner holds its key". An MCP client is not that. The floor
// is therefore hard-coded below and taken from no input.

import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent } from '#lib/vendor/ai-api/agent-adapter.mjs';
import { QuotaExceededError, assertQuotaOk } from '#lib/llm/quota-guard.mjs';
import { ingestTurnEvents } from './ingestion.mjs';
import type { LabreConversationClient } from './labre-conversation-client.mjs';

/** How a turn ended, as the MCP caller sees it. Every value is an EXPECTED
 *  outcome the caller can reason about — none of them is an exception. */
export type AgentReplyStatus =
  /** The message landed; the turn quiesced 'normal'. */
  | 'replied'
  /** The caller's labre AI budget is exhausted (ADR-0032 Decision 2). Not a
   *  degradation and not retryable — no turn was started. */
  | 'quota-exceeded'
  /** The agent is revoked, or not registered, or not visible to this caller
   *  (ADR-0028 Decision 7 — revocation is immediate at every gate). */
  | 'agent-revoked'
  /** The agent is not invited into this conversation (ADR-0028 Decision 4). */
  | 'agent-not-invited'
  /** The claim was refused: another turn is running, or the per-agent daily cap
   *  bit in-transaction. Retryable once the conversation is free. */
  | 'busy'
  /** The caller reached the daemon with a `lab_` API key (or with no bearer at
   *  all). Not a JWT ⇒ no `auth.uid()` ⇒ every RPC on this path is blind. See
   *  ARCH-30, "where the line runs". */
  | 'identity-unsupported'
  /** The daemon is not wired to a labre project (no SUPABASE_URL / anon key) —
   *  a local or stdio deployment. */
  | 'not-configured'
  /** Something failed that is not an expected outcome. The claim, if taken, was
   *  released with reason 'interrupted'. */
  | 'error';

export interface AgentReplyResult {
  status: AgentReplyStatus;
  conversationId: string;
  agentId: string;
  /** The ADR-0013 turn grouping label, present once a claim was taken. */
  turnId?: string;
  /** The ADR-0013 session join key stamped on the message. */
  sessionId?: string;
  /** The inserted `messages.id`, on 'replied'. */
  messageId?: string;
  /** Proposals dropped for an unknown verb — reported, never silent. */
  rejectedCommands?: string[];
  /** Error codes the turn's own event stream carried. */
  errors?: string[];
  /** Used / limit, on 'quota-exceeded'. */
  quota?: { used: number; limit: number };
  /** One human-readable sentence. Never carries a credential or message text. */
  detail?: string;
}

export interface ConductTurnInput {
  conversationId: string;
  agentId: string;
  /** ADR-0013 session key. Minted when the caller does not carry one. */
  sessionId?: string;
  /** The reasoning trace the caller chose to expose. */
  reasoning?: readonly string[];
  /** The turn was cut off at the caller's own model limit. */
  truncated?: boolean;
  /** The map/document this turn worked in. */
  docId?: string | null;
  /** The model label recorded in the ledger. Caller-asserted — see ARCH-30. */
  model?: string;
}

export interface ConductTurnDeps {
  client: LabreConversationClient;
  adapter: AgentAdapter;
  /** The sendTurn quota gate. Injected so a test can prove both branches
   *  without a Supabase project; defaults to the shared hosted-daemon guard. */
  assertQuota?: () => Promise<void>;
  /** Id minting, injected for deterministic tests. */
  newId?: () => string;
  /** Wall clock, injected for a deterministic latency. */
  now?: () => number;
}

/** The claim TTL, in seconds — the 60 s family labre's own claims use. It is
 *  what bounds an orphan if this process dies mid-turn (ADR-0026 Decision 5). */
export const CLAIM_TTL_SECONDS = 60;

/** The ledger's model label when the caller declares none. Honest by name: the
 *  brain was external, and labre-mcp has no way to know which one. */
const DEFAULT_MODEL_LABEL = 'external-agent';

/**
 * Conduct one turn. NEVER throws for an expected outcome — every refusal,
 * including a quota refusal, comes back as a {@link AgentReplyResult} the caller
 * can branch on (ADR-0027 Decision 4).
 */
export async function conductAgentTurn(
  input: ConductTurnInput,
  deps: ConductTurnDeps,
): Promise<AgentReplyResult> {
  const { client, adapter } = deps;
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => Date.now());
  const assertQuota = deps.assertQuota ?? assertQuotaOk;
  const base = { conversationId: input.conversationId, agentId: input.agentId };

  // ── 1. Quota, at sendTurn, before anything is claimed ────────────────────
  try {
    await assertQuota();
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return {
        ...base,
        status: 'quota-exceeded',
        quota: { used: err.used, limit: err.limit },
        detail: err.message,
      };
    }
    // The guard is fail-open by house posture (ADR-0027 Decision 3): anything
    // that is not a positive refusal lets the turn proceed.
  }

  // ── 2. Advisory pre-checks, so a refusal carries a reason ────────────────
  try {
    const status = await client.readAgentStatus(input.agentId);
    if (status !== 'active') {
      return {
        ...base,
        status: 'agent-revoked',
        detail:
          status === null
            ? 'this agent is not registered, or not visible from this conversation'
            : `this agent is ${status}`,
      };
    }
    if (!(await client.isAgentInvited(input.conversationId, input.agentId))) {
      return {
        ...base,
        status: 'agent-not-invited',
        detail: 'this agent is not invited into this conversation',
      };
    }
  } catch {
    // Advisory only. A read that fails must not refuse a turn the DB would
    // have allowed — the claim below is the gate that actually decides.
  }

  // ── 3. Claim ─────────────────────────────────────────────────────────────
  const token = newId();
  const turnId = newId();
  const sessionId = input.sessionId ?? newId();
  let claimed = false;
  try {
    claimed = await client.claimTurn({
      conversationId: input.conversationId,
      token,
      ttlSeconds: CLAIM_TTL_SECONDS,
      turnId,
      agentId: input.agentId,
    });
  } catch (err) {
    return { ...base, status: 'error', detail: describe(err) };
  }
  if (!claimed) {
    return {
      ...base,
      turnId,
      status: 'busy',
      detail:
        'the conversation already has a turn in flight, or this agent is over ' +
        'its daily budget',
    };
  }

  // ── 4–7. Past this point a claim is held: every exit releases it ─────────
  const startedAt = now();
  let released = false;
  const release = async (reason: 'normal' | 'interrupted', produced: boolean) => {
    if (released) return;
    released = true;
    try {
      await client.releaseTurn({
        conversationId: input.conversationId,
        token,
        reason,
        produced,
      });
    } catch {
      // The claim's 60 s TTL is the backstop, and a steal emits the
      // 'lock-expired' quiesce for us. Never mask the real outcome with a
      // release failure.
    }
  };

  try {
    const session = await adapter.createSession({
      conversationId: input.conversationId,
      sessionId,
      // The ADR-0021 guest floor, hard-coded — see the module header.
      scope: 'restricted',
      writeMode: 'ask',
    });

    const events: AgentEvent[] = [];
    const result = await adapter.sendTurn(session, {}, (event) => events.push(event));

    const ingested = ingestTurnEvents(events, {
      reasoning: input.reasoning,
      truncated: input.truncated,
      docId: input.docId,
    });

    if (ingested.content.length === 0) {
      // Nothing to persist. labre's own composer returns null here and the
      // caller surfaces its error instead of writing an empty message.
      await release('interrupted', false);
      return {
        ...base,
        turnId,
        sessionId,
        status: 'error',
        errors: ingested.errors,
        rejectedCommands: ingested.rejectedCommands,
        detail: 'the turn produced nothing to persist',
      };
    }

    const messageId = await client.insertAgentMessage({
      conversationId: input.conversationId,
      content: ingested.content,
      sessionId,
      docId: input.docId,
    });

    // The ledger row. Best-effort by house rule: metering never fails the turn
    // it measured. It goes through record_agent_spend — the EXISTING agent path,
    // which resolves the owner off the claim and stamps source 'external-agent'.
    const usage = result.usage ?? ingested.usage;
    try {
      await client.recordSpend({
        conversationId: input.conversationId,
        token,
        model: input.model?.trim() || DEFAULT_MODEL_LABEL,
        inputTokens: Math.max(0, Math.trunc(usage.inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.trunc(usage.outputTokens ?? 0)),
        latencyMs: Math.max(0, now() - startedAt),
      });
    } catch {
      // Swallowed on purpose (ADR-0032 Decision 3's posture).
    }

    await release('normal', true);
    return {
      ...base,
      turnId,
      sessionId,
      messageId,
      status: 'replied',
      ...(ingested.rejectedCommands.length > 0
        ? { rejectedCommands: ingested.rejectedCommands }
        : {}),
      ...(ingested.errors.length > 0 ? { errors: ingested.errors } : {}),
    };
  } catch (err) {
    // ADR-0026 Decision 5: cancel is idempotent and called on the way out, then
    // the claim is released with an explicit reason so the log records the end.
    try {
      await adapter.cancel({
        conversationId: input.conversationId,
        sessionId,
        scope: 'restricted',
        writeMode: 'ask',
      });
    } catch {
      // A cancel that fails must not swallow the original failure.
    }
    await release('interrupted', false);
    return { ...base, turnId, sessionId, status: 'error', detail: describe(err) };
  }
}

/** One sentence, bounded. Never echoes a bearer: the only credential on this
 *  path is the caller's own JWT, which is sent and never received back. */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}
