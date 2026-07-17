// MCP tool definition for `agentReply` — the external agent's whole-turn
// orchestrator ([A2] slice PR-MCP1, ADR-0026 Decision 4 path 1).
//
// The mentioning sender's client calls this once per turn, passing the sender's
// Supabase JWT (Authorization: Bearer <jwt>). The daemon then conducts one
// external-agent turn AS that caller under RLS: claim → heartbeat → read thread
// → one tool-less LLM call → receipts → persist prose → release. All the
// lifecycle logic lives in agent-turn.mts; this file is the thin MCP seam
// (input schema + auth guard + result mapping), following the run-command.tool
// idiom.

import { z } from 'zod';
import type { ToolDefinition } from '#core/transport/mcp-handler.mjs';
import {
  runAgentTurn,
  type RunAgentTurnInput,
  type AgentTurnAuth,
  type RunAgentTurnResult,
} from '#lib/conversation/agent-turn.mjs';

/** The turn runner, injectable for tests (a fake avoids live Supabase / LLM).
 *  Production uses the real orchestrator. */
export type AgentTurnRunner = (
  input: RunAgentTurnInput,
  auth: AgentTurnAuth,
) => Promise<RunAgentTurnResult>;

// The wire contract. writeMode/scope carry the ADR-0021 posture (defaulted for
// a guest brain: ask + restricted); this prose-only slice proposes no writes,
// so they are threaded but not yet branched on.
const AgentReplyInputSchema = z.object({
  conversationId: z.string().uuid(),
  // uuid: insert_agent_message's p_session_id is a uuid — fail fast at the seam,
  // BEFORE the daemon-billed LLM spend, not at the terminal insert (recette).
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  // ADR-0028 (PR-A4-4): the REGISTERED agent to conduct the turn as — a named
  // LLM provider config owned by the conversation owner. OPTIONAL: absent
  // keeps the [A2] anonymous path byte-for-byte (the daemon's default brain).
  agentId: z.string().uuid().optional(),
  writeMode: z.enum(['auto', 'ask', 'read-only']).default('ask'),
  scope: z.enum(['full', 'restricted']).default('restricted'),
});

/** The tool's own result (the daemon dispatch wraps it in Degradable<T> — do
 *  NOT self-wrap, hard rule #18). 'unsupported-issuer' is the first-class
 *  refusal for a caller whose JWT did not come from the Supabase issuer
 *  (issue #33): valid at the door, worthless against PostgREST (auth.uid()
 *  null) — refused HERE, explicitly, instead of failing invisibly downstream
 *  in an RLS cascade (the A2 recette's MAJOR failure mode). */
interface AgentReplyResult {
  status: RunAgentTurnResult['status'] | 'error' | 'unsupported-issuer';
  messageId?: string;
  error?: string;
}

/** Build the tool, optionally with an injected runner (tests). */
export function buildAgentReplyTool(runner: AgentTurnRunner = runAgentTurn): ToolDefinition {
  return {
    // camelCase like every MCP tool here (estimateEvolution, runCommand, …) AND
    // required by the Anthropic tool-name pattern ^[a-zA-Z0-9_-]{1,64}$ — the
    // previous dotted name (agentReply) made claude.ai reject the whole
    // request of any conversation that included this connector.
    name: 'agentReply',
    description:
      'Conduct ONE external-agent turn on a shared strategy conversation: claim the ' +
      "per-conversation single-flight turn, read the recent thread under the caller's " +
      'RLS, produce one concise prose reply, persist it as an external-agent message, ' +
      'and release the turn. Requires a user JWT (not a lab_ API key). ' +
      'Input: { conversationId, sessionId, turnId, agentId?, writeMode?, scope? }. ' +
      'agentId (optional) names a REGISTERED agent — a per-agent LLM provider ' +
      'configuration — to conduct the turn as; without it the daemon uses its default ' +
      'brain, unchanged. ' +
      'Returns { status: "ok" | "busy" | "degraded" | "quota-exceeded" | ' +
      '"agent-revoked" | "agent-not-invited" | "agent-refused" | ' +
      '"unsupported-issuer" | "error", messageId? }: ' +
      '"busy" = another turn holds the conversation; "degraded" = the turn timed out ' +
      'or errored (the claim was still released; on a registered-agent provider failure ' +
      'a sanitized error notice is posted into the conversation and its messageId is ' +
      'returned); "quota-exceeded" = the caller\'s ' +
      'daily external-agent turn quota is used up (default-brain turns only: a ' +
      "registered-agent turn runs on the agent owner's provider key and is bounded by the " +
      'per-agent daily cap at the claim gate instead; resets at midnight UTC — do not retry); ' +
      '"agent-revoked" = the registered agent was revoked by its owner (do not retry); ' +
      '"agent-not-invited" = the agent is not invited to this conversation (or does not ' +
      'exist — do not retry until invited); "agent-refused" = the agent claim was refused ' +
      'for another reason (do not retry blindly); ' +
      '"unsupported-issuer" = the caller authenticated with a non-Supabase JWT (e.g. an ' +
      'OIDC IdP token on a multi-issuer daemon) — such a token cannot act on conversations ' +
      'under RLS, so this tool requires a Supabase-issued user JWT (do not retry with the ' +
      'same credentials).',
    // any: zod-to-json conversion — the schema is well-typed at the Zod layer.
    inputSchema: z.toJSONSchema(AgentReplyInputSchema, { io: 'input' }) as Record<string, unknown>,
    async handler(args, context): Promise<AgentReplyResult> {
      // Provenance gate FIRST (issue #33): conversation tools accept ONLY
      // Supabase-issued JWTs — an OIDC token is fully valid at the daemon's
      // door yet mints no auth.uid() against PostgREST, so it must be refused
      // here with a first-class status the client can read, never allowed to
      // fail invisibly downstream at RLS. Sources: 'supabase' passes;
      // 'api-key' falls through to the token check below (its long-standing,
      // equally explicit refusal); undefined (in-process/stdio contexts that
      // never crossed an auth middleware) keeps working as before; anything
      // else — 'oidc' today, any future source — is refused fail-closed.
      const source = context.auth?.source;
      if (source !== undefined && source !== 'supabase' && source !== 'api-key') {
        return {
          status: 'unsupported-issuer',
          error:
            'agentReply requires a Supabase-issued user JWT: this call was authenticated ' +
            `by the "${source}" issuer, whose tokens cannot act on conversations under RLS. ` +
            'Strategy tools remain available; do not retry this tool with the same credentials.',
        };
      }

      // RLS pass-through requires the caller's raw JWT (threaded ONLY by the
      // JWT auth modes, jwks-auth.mts). A lab_-key caller resolves a userId but
      // no token — it cannot pass RLS, so it is rejected with a clear message.
      // The inbound-agent (lab_) path is Decision 4 path 2 (definer RPCs), NOT
      // this tool.
      const token = context.auth?.token;
      if (!token) {
        return {
          status: 'error',
          error:
            'agentReply requires a user JWT (Supabase session token). A lab_ API key ' +
            'cannot pass RLS on this path.',
        };
      }

      const input = AgentReplyInputSchema.parse(args);
      const result = await runner(
        {
          conversationId: input.conversationId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          agentId: input.agentId,
          writeMode: input.writeMode,
          scope: input.scope,
        },
        { userId: context.auth?.userId ?? '', token },
      );

      return result.messageId != null
        ? { status: result.status, messageId: result.messageId }
        : { status: result.status };
    },
  };
}

/** The production tool instance registered at boot (boot-tool-registry.mts). */
export const AGENT_REPLY_TOOL: ToolDefinition = buildAgentReplyTool();
