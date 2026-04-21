// Agent SDK provider — wraps createLLMCall / createStructuredLLMCall.
// No logprobs support (subprocess-based runtime does not expose token-level probs).

import { createLLMCall, createStructuredLLMCall } from '../llm-call.mjs';
import type { LLMCall, StructuredLLMCall, LogprobLLMCall } from '../../../types/llm.mjs';
import type { StrategyConfig } from '../config.schema.mjs';
import { UnsupportedCapabilityError, type LLMProvider } from './provider.types.mjs';

export function createAgentSdkProvider(): LLMProvider {
  return {
    kind: 'agent-sdk',
    supports: { text: true, structured: true, logprobs: false },

    text(strategy: StrategyConfig): LLMCall {
      return createLLMCall({
        model: strategy.model,
        effort: strategy.effort,
        systemPrompt: strategy.systemPrompt,
      });
    },

    structured<T = unknown>(
      strategy: StrategyConfig,
      schema: Record<string, unknown>,
    ): StructuredLLMCall<T> {
      return createStructuredLLMCall<T>({
        schema,
        model: strategy.model,
        effort: strategy.effort,
      });
    },

    logprobs(_strategy: StrategyConfig): LogprobLLMCall {
      throw new UnsupportedCapabilityError('agent-sdk', 'logprobs');
    },
  };
}
