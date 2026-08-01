// LLM call primitives (backend-agnostic).
//
// Types aligned with the factories in src/lib/llm/llm-call.mjs:
//   - createLLMCall (Claude Agent SDK backend)
//   - createStructuredLLMCall (schema-constrained output)
//   - createOpenCodeCall (OpenCode gateway backend)
//   - createOpenCodeLogprobCall (OpenCode + logprobs, for kimi-k2.5)

/** Variables d'interpolation pour un template `{{key}}`. */
export type TemplateVariables = Record<string, string | number | boolean | undefined>;

/** Media types accepted as image input.
 *
 *  PNG only today: the single consumer is the Wardley-map vision parser
 *  (`render:wardley-map:image:parse:png`). Widen the union — and every
 *  provider's encoder with it — when a caller genuinely needs jpeg/webp. */
export type LLMImageMediaType = 'image/png';

/** One inline image attached to an LLM call.
 *
 *  `base64` is the RAW payload, WITHOUT any `data:` URI prefix: each provider
 *  wraps it in its own transport encoding (OpenAI-compatible `image_url` data
 *  URI, Anthropic `source.data`, …). Keeping the raw form here means a caller
 *  never has to know which backend will serve the call. */
export interface LLMImageInput {
  mediaType: LLMImageMediaType;
  base64: string;
}

/** Per-call options that can override factory-level configuration. */
export interface LLMCallOptions {
  /** System prompt override. Takes priority over the factory-level systemPrompt
   *  when both are provided. Intended to carry the `.system.md` content of a
   *  split prompt definition. */
  systemPrompt?: string;
  /** Images sent alongside the user prompt (multimodal call). Backends that do
   *  not advertise the `vision` capability REJECT a non-empty list with an
   *  explicit "does not support image input" error — they never drop it
   *  silently, which would surface as an inexplicable quality regression. */
  images?: LLMImageInput[];
}

/** Fonction d'appel LLM texte → texte. */
export type LLMCall = (
  prompt: string,
  variables?: TemplateVariables,
  opts?: LLMCallOptions,
) => Promise<string>;

/** Fonction d'appel LLM texte → JSON structuré (validé par schéma). */
export type StructuredLLMCall<T = unknown> = (
  prompt: string,
  variables?: TemplateVariables,
  opts?: LLMCallOptions,
) => Promise<T>;

/** Config du backend Claude Agent SDK. */
export interface ClaudeLLMConfig {
  /** @default 'claude-sonnet-4-6' */
  model?: string;
  /** @default 'high' */
  effort?: 'low' | 'medium' | 'high';
  /** Optional system prompt */
  systemPrompt?: string;
}

/** Config du backend structuré (Claude + schéma). */
export interface StructuredLLMConfig extends ClaudeLLMConfig {
  /** JSON Schema for the output */
  schema: Record<string, unknown>;
}

/** Config du backend OpenCode (kimi-k2.5 par défaut). */
export interface OpenCodeConfig {
  /** @default 'kimi-k2.5' */
  model?: string;
  /** @default 'https://opencode.ai/zen/v1' */
  baseUrl?: string;
  /** Falls back to process.env.OPENCODE_API_KEY */
  apiKey?: string;
  /** @default 0 */
  temperature?: number;
  /** Optional system prompt, emitted as the first `role: "system"` message. */
  systemPrompt?: string;
}

/** Config du backend OpenCode avec logprobs. */
export interface OpenCodeLogprobConfig extends Omit<OpenCodeConfig, 'temperature'> {
  /** @default 5 */
  topLogprobs?: number;
}

/** Entrée individuelle de logprobs retournée par OpenCode. */
export interface LogprobEntry {
  token: string;
  logprob: number;
}

/** Résultat d'un appel LLM avec logprobs. */
export interface LogprobResult {
  text: string;
  logprobs: LogprobEntry[];
}

/** Fonction d'appel LLM texte → (texte + logprobs). */
export type LogprobLLMCall = (
  prompt: string,
  variables?: TemplateVariables,
  opts?: LLMCallOptions,
) => Promise<LogprobResult>;
