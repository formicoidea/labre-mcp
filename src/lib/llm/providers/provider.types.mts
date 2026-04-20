// Provider abstraction — every provider declares which capabilities it supports
// and exposes typed factories for each one. The registry validates at load time
// that strategies are mapped only to providers that support the required capability,
// so the `throw UnsupportedCapabilityError` paths below should never fire in prod.

import type { LLMCall, StructuredLLMCall, LogprobLLMCall } from '../../../types/llm.mjs';
import type { ProviderConfig, StrategyConfig, ProviderKind } from '../config.schema.mjs';

export type LLMCapability = 'text' | 'structured' | 'logprobs';

export class UnsupportedCapabilityError extends Error {
  constructor(providerKind: ProviderKind, capability: LLMCapability) {
    super(`Provider "${providerKind}" does not support capability "${capability}"`);
    this.name = 'UnsupportedCapabilityError';
  }
}

export interface LLMProvider {
  readonly kind: ProviderKind;
  readonly supports: Readonly<Record<LLMCapability, boolean>>;
  text(strategy: StrategyConfig): LLMCall;
  structured<T = unknown>(strategy: StrategyConfig, schema: Record<string, unknown>): StructuredLLMCall<T>;
  logprobs(strategy: StrategyConfig): LogprobLLMCall;
}

export type ProviderFactory = (config: ProviderConfig) => LLMProvider;
