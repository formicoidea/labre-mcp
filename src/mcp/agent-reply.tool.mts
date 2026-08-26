// MCP tool `agentReply` — the liaison between labre-mcp and labre (ARCH-30).
//
// WHAT IT IS. The MCP caller — a Claude Code session, a CLI, any agent holding a
// labre JWT — conducts ONE turn of a labre conversation under its own identity.
// It is the first consumer of labre's published `AgentAdapter` contract, which
// has existed since ADR-0026 with no implementation on this side of the wire.
//
// WHY THE NAME IS `agentReply` AND NOT `agent.reply`. Every ADR calls this
// `agent.reply`. Hard rule #24b forbids a dot in an MCP tool name — one invalid
// name makes claude.ai reject the whole request of any conversation that
// includes the connector. The camelCase form is what labre's own client already
// calls it (`agentReply` in ADR-0028 Decision 5), so the wire name matches the
// caller and the ADRs' prose name is the concept, not the identifier.
//
// AUTHENTICATION IS NOT DONE HERE. The daemon door already resolved the caller
// (Supabase JWT, OIDC, or a `lab_` key); this tool only READS which bearer that
// was, through the same transport-scoped ALS the cost ledger uses, and hands it
// to PostgREST. No credential is minted, none is stored, none is logged, and
// labre-mcp holds no privileged Supabase key on this path or any other.
//
// A `lab_` KEY IS REFUSED, on purpose and with a reason. It is not a JWT:
// `validate_api_key` resolves it to a bare `user_id` and mints no token, so
// `auth.uid()` is null and every RPC this turn needs — all of them
// `auth.uid()`-bound — would be blind. ADR-0026 Decision 4 path 2 designs the
// key-authenticated DEFINER RPC family that would serve those callers; ADR-0028
// moved it to Future work and it does not exist. So the caller gets
// 'identity-unsupported' with a sentence, never a silent no-op.
//
// NEVER THROWS FOR AN EXPECTED OUTCOME. Quota, revocation, a busy conversation
// and an unsupported identity all come back as a `status` in the RESULT, so the
// calling agent can reason about them (ADR-0027 Decision 4). Only a genuine
// failure reaches the dispatch's degradation wrapper.

import { z } from 'zod';
import type { ToolDefinition } from '#core/registry/tool-registry.mjs';
import { currentLedgerJwt } from '#lib/llm/ledger-auth-context.mjs';
import { CallerSuppliedAdapter } from '#lib/agent/caller-supplied-adapter.mjs';
import {
  type AgentReplyResult,
  conductAgentTurn,
} from '#lib/agent/agent-turn.mjs';
import {
  createPostgrestClient,
  endpointFromEnv,
} from '#lib/agent/labre-conversation-client.mjs';
import { AgentReplyInputSchema } from '#schemas/agent-reply.schema.mjs';

/** A `lab_` personal API key is not a JWT — see the header. */
const API_KEY_PREFIX = 'lab_';

export const AGENT_REPLY_TOOL: ToolDefinition = {
  name: 'agentReply',
  description:
    'Reply in a labre conversation as a registered agent, under YOUR labre identity. ' +
    'Conducts one bounded turn: it claims the conversation (single-flight), persists ' +
    'your prose — plus any commands you PROPOSE, which a human applies — records the ' +
    'spend on the agent ledger, and releases the claim. ' +
    'Input: { conversationId, agentId, text, reasoning?, commands?, docId?, usage?, model? }. ' +
    'Never throws for an expected outcome — read `status`: "replied", "quota-exceeded", ' +
    '"agent-revoked", "agent-not-invited", "busy", "identity-unsupported", ' +
    '"not-configured", "error". Requires a Supabase JWT bearer (a lab_ API key ' +
    'cannot conduct a turn).',
  // any: zod-to-json conversion — the schema is well-typed at the Zod layer
  inputSchema: z.toJSONSchema(AgentReplyInputSchema, { io: 'input' }) as Record<
    string,
    unknown
  >,
  // No telemetryTarget on purpose (CH-09): what this call targets is a
  // conversation uuid, and a uuid as a PostHog property is a cardinality leak —
  // exactly what the ToolDefinition contract warns against. The tool still emits
  // `mcp_tool_call` with its status through the dispatch wrapper.

  // Returns a bare AgentReplyResult; the dispatch wraps every handler in
  // withMcpDegradation (hard rule #18) — do NOT self-wrap here.
  async handler(args): Promise<AgentReplyResult> {
    const input = AgentReplyInputSchema.parse(args);
    const base = { conversationId: input.conversationId, agentId: input.agentId };

    const jwt = currentLedgerJwt();
    if (!jwt || jwt.startsWith(API_KEY_PREFIX)) {
      return {
        ...base,
        status: 'identity-unsupported',
        detail: jwt
          ? 'a lab_ API key cannot conduct a conversation turn: it is not a JWT, ' +
            'so labre\'s row-level security cannot resolve who is acting. ' +
            'Connect with a Supabase session token instead.'
          : 'no caller identity reached this tool — agentReply needs the hosted ' +
            'daemon with a Supabase JWT bearer (stdio and lib mode cannot act in ' +
            'a labre conversation).',
      };
    }

    const endpoint = endpointFromEnv(jwt);
    if (!endpoint) {
      return {
        ...base,
        status: 'not-configured',
        detail: 'this daemon is not wired to a labre project (SUPABASE_URL / ' +
          'SUPABASE_ANON_KEY are unset).',
      };
    }

    return conductAgentTurn(
      {
        conversationId: input.conversationId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        reasoning: input.reasoning,
        truncated: input.truncated,
        docId: input.docId,
        model: input.model,
      },
      {
        client: createPostgrestClient(endpoint),
        adapter: new CallerSuppliedAdapter({
          text: input.text,
          reasoning: input.reasoning,
          commands: input.commands,
          truncated: input.truncated,
          usage: input.usage,
        }),
      },
    );
  },
};
