// MCP tool definition for `agent.reply` — the external agent's whole-turn
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
  writeMode: z.enum(['auto', 'ask', 'read-only']).default('ask'),
  scope: z.enum(['full', 'restricted']).default('restricted'),
});

/** The tool's own result (the daemon dispatch wraps it in Degradable<T> — do
 *  NOT self-wrap, hard rule #18). */
interface AgentReplyResult {
  status: RunAgentTurnResult['status'] | 'error';
  messageId?: string;
  error?: string;
}

/** Build the tool, optionally with an injected runner (tests). */
export function buildAgentReplyTool(runner: AgentTurnRunner = runAgentTurn): ToolDefinition {
  return {
    name: 'agent.reply',
    description:
      'Conduct ONE external-agent turn on a shared strategy conversation: claim the ' +
      "per-conversation single-flight turn, read the recent thread under the caller's " +
      'RLS, produce one concise prose reply, persist it as an external-agent message, ' +
      'and release the turn. Requires a user JWT (not a lab_ API key). ' +
      'Input: { conversationId, sessionId, turnId, writeMode?, scope? }. ' +
      'Returns { status: "ok" | "busy" | "degraded" | "quota-exceeded" | "error", messageId? }: ' +
      '"busy" = another turn holds the conversation; "degraded" = the turn timed out ' +
      'or errored (the claim was still released); "quota-exceeded" = the caller\'s ' +
      'daily external-agent turn quota is used up (resets at midnight UTC — do not retry).',
    // any: zod-to-json conversion — the schema is well-typed at the Zod layer.
    inputSchema: z.toJSONSchema(AgentReplyInputSchema, { io: 'input' }) as Record<string, unknown>,
    async handler(args, context): Promise<AgentReplyResult> {
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
            'agent.reply requires a user JWT (Supabase session token). A lab_ API key ' +
            'cannot pass RLS on this path.',
        };
      }

      const input = AgentReplyInputSchema.parse(args);
      const result = await runner(
        {
          conversationId: input.conversationId,
          sessionId: input.sessionId,
          turnId: input.turnId,
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
