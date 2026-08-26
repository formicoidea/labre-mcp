// The liaison's data door onto labre (ARCH-30; ADR-0026 Decision 4, path 1).
//
// ZERO PRIVILEGED CREDENTIAL, and that is a repository invariant, not a
// preference: every call below goes out under the CALLER's own bearer JWT plus
// the public anon key, the same posture as `supabase-bundle-source.mts` and
// `ledger-report.mts`. labre-mcp holds no service-role key, reads no provider
// secret, and mints no token. If a call is refused, it is refused because RLS or
// a DEFINER gate said so about the CALLER — never because labre-mcp lacked a
// power it should not have had.
//
// WHY EVERY WRITE IS AN RPC AND NOT A TABLE INSERT. labre's sender-coherence
// policy makes direct `messages` inserts human-only; an external-agent row can
// only be minted by `insert_agent_message`, which hard-codes the actor, reads
// the conducting `agent_id` OFF the active claim row (never a parameter) and
// re-checks registration + invite at write time. The claim, the ledger row and
// the release are the same story. So this file names five RPCs and one table
// read, and holds no authorisation logic of its own: the DB is the gate.
//
// THE INTERFACE EXISTS FOR THE TESTS. `LabreConversationClient` is what the
// orchestrator depends on, so every status of a turn — busy, revoked, refused,
// released — is provable against a stub with no network and no database. The
// PostgREST implementation below is the only place a URL appears.

/** The five RPCs and one read the liaison needs. Implemented over PostgREST in
 *  production, stubbed in tests. */
export interface LabreConversationClient {
  /** `public.agents` row status, or null when the caller cannot see the agent
   *  at all (not registered, or not member-visible from this conversation). */
  readAgentStatus(agentId: string): Promise<string | null>;
  /** True when the agent is invited into this conversation
   *  (`conversation_agent_shares`, member-readable). */
  isAgentInvited(conversationId: string, agentId: string): Promise<boolean>;
  /** `claim_agent_turn` — the external-agent single-flight claim. False covers
   *  every in-transaction refusal: busy, unregistered, uninvited, over the
   *  per-agent cap. The pre-checks above are what let the orchestrator name the
   *  common ones instead of returning an opaque 'busy'. */
  claimTurn(input: {
    conversationId: string;
    token: string;
    ttlSeconds: number;
    turnId: string;
    agentId: string;
  }): Promise<boolean>;
  /** `insert_agent_message` — returns the inserted message id. */
  insertAgentMessage(input: {
    conversationId: string;
    content: unknown;
    sessionId: string;
    docId?: string | null;
  }): Promise<string>;
  /** `record_agent_spend` — the ledger row, attributed to the AGENT'S OWNER
   *  through the claim (ADR-0028 Decision 6). Best-effort at the call site. */
  recordSpend(input: {
    conversationId: string;
    token: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }): Promise<void>;
  /** `release_conversation_turn` with an explicit reason — the mandatory quiesce
   *  (ADR-0026 Decision 5). Idempotent server-side on a token mismatch. */
  releaseTurn(input: {
    conversationId: string;
    token: string;
    reason: 'normal' | 'interrupted';
    produced: boolean;
  }): Promise<void>;
}

/** Raised when PostgREST answers a non-2xx. Carries the status so the
 *  orchestrator can tell an authorisation refusal (401/403/42501) from an
 *  outage, without parsing prose. */
export class LabreRpcError extends Error {
  constructor(
    readonly rpc: string,
    readonly httpStatus: number,
    readonly detail: string,
  ) {
    super(`${rpc} failed (${httpStatus}): ${detail}`);
    this.name = 'LabreRpcError';
  }
}

/** Where the door is and who is knocking. */
export interface LabreEndpoint {
  supabaseUrl: string;
  anonKey: string;
  /** The CALLER's bearer JWT. Never a service key — see the header. */
  jwt: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Read the endpoint from the process environment, or null when labre is not
 *  configured (stdio/local runs, lib mode, CI). Env is read HERE and nowhere
 *  else on this path, the same concession `ledger-report.mts` already makes to
 *  hard rule #20 for the two other labre calls. */
export function endpointFromEnv(jwt: string): Omit<LabreEndpoint, 'fetchImpl'> | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;
  return { supabaseUrl, anonKey, jwt };
}

export function createPostgrestClient(endpoint: LabreEndpoint): LabreConversationClient {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const headers = {
    apikey: endpoint.anonKey,
    authorization: `Bearer ${endpoint.jwt}`,
    'content-type': 'application/json',
  };

  async function call(rpc: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await doFetch(`${endpoint.supabaseUrl}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // The body may carry a Postgres message; it never carries a credential —
      // the only bearer in play is the caller's own, which we send, not receive.
      throw new LabreRpcError(rpc, res.status, (await res.text()).slice(0, 500));
    }
    const text = await res.text();
    return text.length > 0 ? (JSON.parse(text) as unknown) : null;
  }

  async function select(path: string): Promise<unknown[]> {
    const res = await doFetch(`${endpoint.supabaseUrl}/rest/v1/${path}`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      throw new LabreRpcError(path, res.status, (await res.text()).slice(0, 500));
    }
    const parsed = (await res.json()) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }

  return {
    async readAgentStatus(agentId) {
      const rows = await select(
        `agents?id=eq.${encodeURIComponent(agentId)}&select=status&limit=1`,
      );
      const row = rows[0] as { status?: unknown } | undefined;
      return typeof row?.status === 'string' ? row.status : null;
    },

    async isAgentInvited(conversationId, agentId) {
      const rows = await select(
        `conversation_agent_shares?conversation_id=eq.${encodeURIComponent(conversationId)}` +
          `&agent_id=eq.${encodeURIComponent(agentId)}&select=agent_id&limit=1`,
      );
      return rows.length > 0;
    },

    async claimTurn({ conversationId, token, ttlSeconds, turnId, agentId }) {
      const claimed = await call('claim_agent_turn', {
        p_conversation_id: conversationId,
        p_token: token,
        p_ttl_seconds: ttlSeconds,
        p_turn_id: turnId,
        p_agent_id: agentId,
      });
      return claimed === true;
    },

    async insertAgentMessage({ conversationId, content, sessionId, docId }) {
      // `p_session_id` is TEXT since 20260826112700 (CH-19): the client mints it
      // and the server does not adjudicate it — pass it through as written.
      const rows = await call('insert_agent_message', {
        p_conversation_id: conversationId,
        p_content: content,
        p_session_id: sessionId,
        p_doc_id: docId ?? null,
        p_element_id: null,
        p_framework: null,
      });
      const row = (Array.isArray(rows) ? rows[0] : rows) as { id?: unknown } | null;
      if (!row || typeof row.id !== 'string') {
        throw new LabreRpcError('insert_agent_message', 200, 'no message row returned');
      }
      return row.id;
    },

    async recordSpend({ conversationId, token, model, inputTokens, outputTokens, latencyMs }) {
      await call('record_agent_spend', {
        p_conversation_id: conversationId,
        p_token: token,
        p_model: model,
        p_input_tokens: inputTokens,
        p_output_tokens: outputTokens,
        p_latency_ms: latencyMs,
      });
    },

    async releaseTurn({ conversationId, token, reason, produced }) {
      await call('release_conversation_turn', {
        p_conversation_id: conversationId,
        p_token: token,
        p_reason: reason,
        p_produced: produced,
      });
    },
  };
}
