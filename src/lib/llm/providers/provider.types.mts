// Provider abstraction — every provider declares which capabilities it supports
// and exposes typed factories for each one. The registry validates at load time
// that strategies are mapped only to providers that support the required capability,
// so the `throw UnsupportedCapabilityError` paths below should never fire in prod.

import type { LLMCall, StructuredLLMCall, LogprobLLMCall } from '../../../types/llm.mjs';
import type { ProviderConfig, StrategyConfig, ProviderKind } from '../config.schema.mjs';

// `vision` is a MODALITY, not an output shape: it means "this provider can put
// an image in the request". It is modelled as a capability anyway so it travels
// through the same registry assertion as the others, and so the exhaustive
// `Record<LLMCapability, boolean>` forces every provider to answer the question.
export type LLMCapability = 'text' | 'structured' | 'logprobs' | 'vision';

export class UnsupportedCapabilityError extends Error {
  constructor(providerKind: ProviderKind, capability: LLMCapability) {
    super(`Provider "${providerKind}" does not support capability "${capability}"`);
    this.name = 'UnsupportedCapabilityError';
  }
}

/** Dedicated error for the image modality — the message is the contract callers
 *  and tests assert on, and it says what is actually missing rather than naming
 *  an abstract "capability". */
export class UnsupportedVisionError extends Error {
  constructor(providerKind: ProviderKind) {
    super(`Provider "${providerKind}" does not support image input`);
    this.name = 'UnsupportedVisionError';
  }
}

export interface LLMProvider {
  readonly kind: ProviderKind;
  readonly supports: Readonly<Record<LLMCapability, boolean>>;
  text(strategy: StrategyConfig): LLMCall;
  structured<T = unknown>(strategy: StrategyConfig, schema: Record<string, unknown>): StructuredLLMCall<T>;
  logprobs(strategy: StrategyConfig): LogprobLLMCall;
  /** Text completion that additionally accepts `opts.images`. Same return type
   *  as `text()` — vision is an input modality, the output stays text. */
  vision(strategy: StrategyConfig): LLMCall;
}

export type ProviderFactory = (config: ProviderConfig) => LLMProvider;
