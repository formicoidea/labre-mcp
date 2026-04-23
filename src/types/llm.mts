// LLM call primitives (backend-agnostic).
//
// Types aligned with the factories in src/lib/llm/llm-call.mjs:
//   - createLLMCall (Claude Agent SDK backend)
//   - createStructuredLLMCall (schema-constrained output)
//   - createOpenCodeCall (OpenCode gateway backend)
//   - createOpenCodeLogprobCall (OpenCode + logprobs, for kimi-k2.5)

/** Variables d'interpolation pour un template `{{key}}`. */
export type TemplateVariables = Record<string, string | number | boolean | undefined>;

/** Per-call options that can override factory-level configuration. */
export interface LLMCallOptions {
  /** System prompt override. Takes priority over the factory-level systemPrompt
   *  when both are provided. Intended to carry the `.system.md` content of a
   *  split prompt definition. */
  systemPrompt?: string;
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
