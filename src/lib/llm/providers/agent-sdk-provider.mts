// Agent SDK provider — wraps createLLMCall / createStructuredLLMCall.
// No logprobs support (subprocess-based runtime does not expose token-level probs).

import { createLLMCall, createStructuredLLMCall } from '../llm-call.mjs';
import type { LLMCall, StructuredLLMCall, LogprobLLMCall } from '../../../types/llm.mjs';
import type { StrategyConfig } from '../config.schema.mjs';
import {
  UnsupportedCapabilityError,
  UnsupportedVisionError,
  type LLMProvider,
} from './provider.types.mjs';

export function createAgentSdkProvider(): LLMProvider {
  return {
    kind: 'agent-sdk',
    // vision: false — the SDK could carry images (query() accepts an
    // AsyncIterable<SDKUserMessage> whose `message` is an Anthropic MessageParam,
    // sdk.d.ts:1687/2631) but this provider drives it in plain string-prompt
    // mode, and the Anthropic content-block types are not installed here
    // (@anthropic-ai/sdk is absent from node_modules). Flip to true only
    // together with a real streaming-input driver.
    supports: { text: true, structured: true, logprobs: false, vision: false },

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
        systemPrompt: strategy.systemPrompt,
      });
    },

    logprobs(_strategy: StrategyConfig): LogprobLLMCall {
      throw new UnsupportedCapabilityError('agent-sdk', 'logprobs');
    },

    vision(_strategy: StrategyConfig): LLMCall {
      throw new UnsupportedVisionError('agent-sdk');
    },
  };
}
