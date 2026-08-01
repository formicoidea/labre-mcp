// HTTP API provider — wraps createOpenCodeCall / createOpenCodeLogprobCall.
// Supports text + logprobs. Structured output is not implemented yet
// (no consumer today — would require prompt-engineered JSON enforcement).

import { createOpenCodeCall, createOpenCodeLogprobCall } from '../llm-call.mjs';
import type { LLMCall, StructuredLLMCall, LogprobLLMCall } from '../../../types/llm.mjs';
import type { ProviderConfig, StrategyConfig } from '../config.schema.mjs';
import { UnsupportedCapabilityError, type LLMProvider } from './provider.types.mjs';

export function createHttpApiProvider(providerConfig: ProviderConfig): LLMProvider {
  const apiKey = providerConfig.apiKeyEnv ? process.env[providerConfig.apiKeyEnv] : undefined;
  const baseUrl = providerConfig.baseUrl;

  return {
    kind: 'http-api',
    // `vision: true` is a TRANSPORT claim: the OpenAI-compatible body can carry
    // an image part. Whether the MODEL a strategy points at can read it is a
    // configuration question, answered in llm.config.json.
    supports: { text: true, structured: false, logprobs: true, vision: true },

    text(strategy: StrategyConfig): LLMCall {
      return createOpenCodeCall({
        model: strategy.model,
        baseUrl,
        apiKey,
        temperature: strategy.temperature,
        systemPrompt: strategy.systemPrompt,
      });
    },

    // Same driver as text(): `createOpenCodeCall` encodes `opts.images` when
    // present and produces a byte-identical body when absent.
    vision(strategy: StrategyConfig): LLMCall {
      return createOpenCodeCall({
        model: strategy.model,
        baseUrl,
        apiKey,
        temperature: strategy.temperature,
        systemPrompt: strategy.systemPrompt,
      });
    },

    structured<T = unknown>(
      _strategy: StrategyConfig,
      _schema: Record<string, unknown>,
    ): StructuredLLMCall<T> {
      throw new UnsupportedCapabilityError('http-api', 'structured');
    },

    logprobs(strategy: StrategyConfig): LogprobLLMCall {
      return createOpenCodeLogprobCall({
        model: strategy.model,
        baseUrl,
        apiKey,
        topLogprobs: strategy.topLogprobs,
        systemPrompt: strategy.systemPrompt,
      });
    },
  };
}
