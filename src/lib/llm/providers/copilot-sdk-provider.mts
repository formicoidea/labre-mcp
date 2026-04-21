// Copilot SDK provider — wraps createCopilotSdkTextCall / createCopilotSdkStructuredCall.
// No logprobs support (the SDK only emits free-form `assistant.message` events).
//
// Auth: the provider reads the GitHub token from the env var named in
// `providerConfig.authEnv` (typically COPILOT_GITHUB_TOKEN). When unset, the
// underlying SDK falls back to `gh auth login` credentials or GH_TOKEN /
// GITHUB_TOKEN.

import {
  createCopilotSdkTextCall,
  createCopilotSdkStructuredCall,
} from '../copilot-sdk-call.mjs';
import type { LLMCall, StructuredLLMCall, LogprobLLMCall } from '../../../types/llm.mjs';
import type { ProviderConfig, StrategyConfig } from '../config.schema.mjs';
import { UnsupportedCapabilityError, type LLMProvider } from './provider.types.mjs';

export function createCopilotSdkProvider(providerConfig: ProviderConfig): LLMProvider {
  const githubToken = providerConfig.authEnv
    ? process.env[providerConfig.authEnv]
    : undefined;

  return {
    kind: 'copilot-sdk',
    supports: { text: true, structured: true, logprobs: false },

    text(strategy: StrategyConfig): LLMCall {
      return createCopilotSdkTextCall({
        model: strategy.model,
        githubToken,
        systemPrompt: strategy.systemPrompt,
      });
    },

    structured<T = unknown>(
      strategy: StrategyConfig,
      schema: Record<string, unknown>,
    ): StructuredLLMCall<T> {
      return createCopilotSdkStructuredCall<T>({
        schema,
        model: strategy.model,
        githubToken,
        systemPrompt: strategy.systemPrompt,
      });
    },

    logprobs(_strategy: StrategyConfig): LogprobLLMCall {
      throw new UnsupportedCapabilityError('copilot-sdk', 'logprobs');
    },
  };
}
