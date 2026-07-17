// Per-turn LLM provider drivers for REGISTERED agents (PR-A4-4, ADR-0028
// Decisions 3c/5): a registered agent IS a named provider configuration
// (anthropic | openai | openai-compatible), and the conductor's LLM backend
// becomes selectable PER TURN from that configuration — fetched via
// get_agent_provider_config at turn start (agent-turn.mts) and turned into an
// LLMCall here.
//
// SECRET DISCIPLINE (the ADR's red point): the provider secret lives ONLY in
// the returned closure for the duration of one turn. It is sent as an auth
// header to the configured provider and nowhere else — never logged, never in
// degradation events or receipts, never echoed in error messages (errors carry
// only an HTTP status + a bounded response-body excerpt, and the excerpt comes
// from the PROVIDER's response, not from our request). base_url is refused
// outright when it embeds credentials, so no error/log path can ever leak them.
//
// Reuse over reinvention: the openai and openai-compatible drivers ARE the
// daemon's existing OpenAI-compatible Chat Completions plumbing
// (createOpenCodeCall) parameterized per turn — no new dependency, native
// fetch. Only the anthropic driver (Messages API) is new, same fetch idiom.

import { createOpenCodeCall, interpolate } from '#lib/llm/llm-call.mjs';
import { classifyLLMError, classifyAndLogLLMError } from '#lib/llm/llm-error-handler.mjs';
import { recordLlmUsage } from '#lib/llm/usage-context.mjs';
import type { LLMCall } from '#types/llm.mjs';

/** The per-turn provider configuration as delivered by
 *  get_agent_provider_config (names mirror the agents table columns).
 *  `secret` is the provider API key — turn-scoped memory only. */
export interface AgentProviderConfig {
  provider: 'anthropic' | 'openai' | 'openai-compatible';
  model: string;
  /** Meaningful for 'openai-compatible' (the endpoint base). NULL otherwise. */
  baseUrl: string | null;
  secret: string;
}

// Anthropic Messages API endpoint + the stable API version header.
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// OpenAI's public Chat Completions base (the 'openai' provider is the
// compatible driver pinned to this base).
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
// Deliberately modest output ceiling: an agent turn is one concise
// conversational reply (the system prompt asks for short prose), and the spend
// lands on the agent OWNER's provider account.
const MAX_OUTPUT_TOKENS = 4096;
// Bound provider error bodies in thrown messages (they feed MCP logs).
const ERROR_BODY_EXCERPT = 500;

/**
 * Build the per-turn LLMCall for a registered agent's provider config.
 * Selection is by `config.provider`; the secret is captured by the closure and
 * must not outlive the turn (callers drop the reference when the turn settles).
 */
export function createAgentProviderCall(config: AgentProviderConfig): LLMCall {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicMessagesCall(config);
    case 'openai':
      // The existing Chat Completions plumbing, pinned to OpenAI's base.
      return createOpenCodeCall({
        model: config.model,
        baseUrl: OPENAI_BASE_URL,
        apiKey: config.secret,
      });
    case 'openai-compatible':
      return createOpenCodeCall({
        model: config.model,
        baseUrl: requireCleanBaseUrl(config.baseUrl),
        apiKey: config.secret,
      });
  }
}

/**
 * Validate the openai-compatible base_url WITHOUT ever echoing it: a
 * malformed, credential-carrying, non-https (except localhost dev targets),
 * or query/hash-carrying URL is refused with a STATIC message (the URL itself
 * may embed user:pass — quoting it in an error would leak into logs/receipts).
 */
function requireCleanBaseUrl(baseUrl: string | null): string {
  if (baseUrl == null || baseUrl.trim().length === 0) {
    throw new Error('agent provider config: base_url is required for an openai-compatible provider');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error('agent provider config: base_url is not a valid URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('agent provider config: base_url must not embed credentials');
  }
  // https only — the secret rides the Authorization header of every request to
  // this base. Plain http is tolerated ONLY for local development targets.
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new Error(
      'agent provider config: base_url must use https (http is allowed for localhost only)',
    );
  }
  // A query string or fragment would break the `${baseUrl}/chat/completions`
  // concatenation SILENTLY — refuse instead of calling a mangled endpoint.
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('agent provider config: base_url must not carry a query string or fragment');
  }
  // createOpenCodeCall appends '/chat/completions' — normalize trailing slashes.
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Anthropic Messages API driver (native fetch, non-streaming, tool-less). */
function createAnthropicMessagesCall(config: AgentProviderConfig): LLMCall {
  const model = config.model;
  const secret = config.secret;

  return async function anthropicMessagesCall(prompt, variables, opts) {
    const interpolatedPrompt = interpolate(prompt, variables);
    const errorContext = { logger: 'agent-provider-anthropic', model };

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The secret rides this header ONLY — never a URL, never a log.
          'x-api-key': secret,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(opts?.systemPrompt ? { system: opts.systemPrompt } : {}),
          messages: [{ role: 'user', content: interpolatedPrompt }],
        }),
      });
    } catch (fetchErr) {
      classifyAndLogLLMError(fetchErr, errorContext);
      throw fetchErr;
    }

    if (!response.ok) {
      // Status + a bounded excerpt of the PROVIDER's response body: no request
      // data (and therefore no secret) can appear here.
      const body = await response.text();
      const apiErr = new Error(
        `Anthropic API error ${response.status}: ${body.slice(0, ERROR_BODY_EXCERPT)}`,
      );
      classifyAndLogLLMError(apiErr, errorContext);
      throw apiErr;
    }

    // Messages API success: content blocks + usage.{input_tokens,output_tokens}.
    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    recordLlmUsage({
      provider: 'anthropic-api',
      model,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    });

    const text = (data.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');

    if (text.length === 0) {
      // Mirrors the Chat Completions driver: an empty completion (e.g. a
      // provider-side refusal) throws so the turn degrades observably instead
      // of silently producing nothing.
      const emptyErr = new Error('Anthropic call returned empty response');
      classifyAndLogLLMError(emptyErr, errorContext);
      throw emptyErr;
    }
    return text;
  };
}

/**
 * The SANITIZED, member-facing error notice posted into the conversation when
 * the agent's provider fails mid-turn (agent-turn.mts). Built from the
 * classified error TYPE + HTTP status only — never from err.message, which may
 * carry provider response text or internals. Static English prose (daemon-side
 * copy, like the agent system prompt; the app-shell i18n rule does not reach
 * daemon-authored conversation messages).
 */
export function providerErrorNotice(err: unknown): string {
  const classified = classifyLLMError(err);
  switch (classified.type) {
    case 'auth':
      return (
        `The agent could not reply: its LLM provider rejected the configured API key ` +
        `(HTTP ${classified.status ?? 401}). The agent owner may need to update the key ` +
        `in the agent settings.`
      );
    case 'rate_limit':
      return (
        'The agent could not reply: its LLM provider is rate-limiting requests (HTTP 429). ' +
        'Try again later.'
      );
    case 'timeout':
      return 'The agent could not reply: its LLM provider timed out.';
    case 'network':
      return 'The agent could not reply: its LLM provider could not be reached.';
    case 'empty_response':
      return 'The agent could not reply: its LLM provider returned an empty response.';
    case 'api_error':
      return (
        `The agent could not reply: its LLM provider returned an error ` +
        `(HTTP ${classified.status ?? 500}).`
      );
    default:
      return 'The agent could not reply: the call to its LLM provider failed.';
  }
}

/** Notice for a provider-CONFIG read failure (get_agent_provider_config
 *  refused or returned nothing): revoked mid-claim, or no secret registered.
 *  Static text — the RPC error is never echoed. */
export const PROVIDER_CONFIG_NOTICE =
  'The agent could not reply: its provider configuration could not be read. ' +
  'The agent may have been revoked, or its API key may not be registered yet.';
