// The wire contract of the `agentReply` liaison (ARCH-30).
//
// One turn of a labre conversation, handed in whole by the MCP caller: the prose
// its brain produced, optionally its reasoning trace and the commands it wants to
// PROPOSE. Nothing here is a credential and nothing here is an identity — who
// acts is the caller's own bearer, resolved at the daemon door, never a field.
//
// `.strict()` on purpose: a caller that invents `agentSecret` or `asUser` must
// get a validation error, not a silently ignored key.

import { z } from 'zod';

/** A command the agent proposes. The verb is checked against labre's published
 *  allow-list at ingestion (see `ai-command-names.mts`); the parameters are
 *  carried opaquely because the human's client — not this conduit — applies and
 *  therefore validates them (ARCH-30, narrowing 1). */
export const AgentReplyCommandSchema = z
  .object({
    type: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

/** Token accounting, as the caller reports it. Caller-asserted by construction:
 *  labre-mcp did not make this call and cannot measure it (ARCH-30). */
export const AgentReplyUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
  })
  .strict();

export const AgentReplyInputSchema = z
  .object({
    /** The labre conversation to reply in. */
    conversationId: z.uuid(),
    /** The registered agent whose identity this turn speaks under. Required:
     *  the anonymous path was retired by labre's `agent_id_required` migration,
     *  so a turn without an agent is refused by the database anyway. */
    agentId: z.uuid(),
    /** The final prose — the message bubble. */
    text: z.string().min(1).max(50_000),
    /** Per-round reasoning, persisted as the collapsible trace. */
    reasoning: z.array(z.string().max(10_000)).max(50).optional(),
    /** Proposals. Held `pending` — a human's client applies them (ask mode). */
    commands: z.array(AgentReplyCommandSchema).max(50).optional(),
    /** The caller's own answer was cut off at its model's output limit. */
    truncated: z.boolean().optional(),
    /** ADR-0013 session join key. Minted server-side when absent. */
    sessionId: z.string().min(1).max(200).optional(),
    /** The map/document this turn worked in (ADR-0013 `doc_id` join key). */
    docId: z.uuid().optional(),
    /** Model label for the ledger row. Free text: labre-mcp cannot verify which
     *  brain answered, and says so rather than inventing a name. */
    model: z.string().min(1).max(200).optional(),
    /** What the turn cost the caller. */
    usage: AgentReplyUsageSchema.optional(),
  })
  .strict();

export type AgentReplyInput = z.infer<typeof AgentReplyInputSchema>;
