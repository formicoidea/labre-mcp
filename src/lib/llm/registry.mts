// Registry — single entry point to obtain an LLM call for a given MCP strategy.
//
// Lookup path:
//   1. loadLLMConfig() returns the validated LLMConfig
//   2. validateCapabilities() (called once) ensures every known strategy is
//      assigned to a provider that supports the required capability
//   3. getStrategyLLM / getStrategyStructuredLLM / getStrategyLogprobLLM
//      resolve the strategy entry (falling back to defaultProvider) and
//      return a cached call instance

import { loadLLMConfig } from './config.loader.mjs';
import type { LLMConfig, ProviderConfig, ProviderKind, StrategyConfig } from './config.schema.mjs';
import { createAgentSdkProvider } from './providers/agent-sdk-provider.mjs';
import { createHttpApiProvider } from './providers/http-api-provider.mjs';
import { createCopilotSdkProvider } from './providers/copilot-sdk-provider.mjs';
import type { LLMCapability, LLMProvider } from './providers/provider.types.mjs';
import { STRATEGY_CAPABILITIES, type StrategyId } from './strategy-ids.mjs';
import type { LLMCall, StructuredLLMCall, LogprobLLMCall } from '../../types/llm.mjs';

type CallCacheKey = `${string}:${LLMCapability}`;
const callCache = new Map<CallCacheKey, unknown>();
const providerCache = new Map<string, LLMProvider>();
const testOverrides = new Map<CallCacheKey, unknown>();
let validated = false;

const PROVIDER_FACTORIES: Record<ProviderKind, (cfg: ProviderConfig) => LLMProvider> = {
  'agent-sdk':   () => createAgentSdkProvider(),
  'http-api':    (cfg) => createHttpApiProvider(cfg),
  'copilot-sdk': (cfg) => createCopilotSdkProvider(cfg),
};

function instantiateProvider(id: string, cfg: LLMConfig): LLMProvider {
  const cached = providerCache.get(id);
  if (cached) return cached;
  const providerCfg = cfg.providers[id];
  if (!providerCfg) throw new Error(`Unknown provider "${id}"`);
  const factory = PROVIDER_FACTORIES[providerCfg.kind];
  if (!factory) {
    throw new Error(`No factory registered for provider kind "${providerCfg.kind}"`);
  }
  const provider = factory(providerCfg);
  providerCache.set(id, provider);
  return provider;
}

function validateCapabilities(cfg: LLMConfig): void {
  if (validated) return;
  for (const [stratId, requiredCap] of Object.entries(STRATEGY_CAPABILITIES)) {
    const strategy = cfg.strategies[stratId];
    const providerId = strategy?.provider ?? cfg.defaultProvider;
    const providerCfg = cfg.providers[providerId];
    if (!providerCfg) {
      throw new Error(
        `Strategy "${stratId}" resolves to unknown provider "${providerId}"`,
      );
    }
    const provider = instantiateProvider(providerId, cfg);
    if (!provider.supports[requiredCap]) {
      throw new Error(
        `Strategy "${stratId}" requires capability "${requiredCap}" but provider "${providerId}" (${providerCfg.kind}) does not support it`,
      );
    }
  }
  validated = true;
}

function resolveStrategy(id: StrategyId, cfg: LLMConfig): { strategy: StrategyConfig; provider: LLMProvider } {
  const explicit = cfg.strategies[id];
  if (explicit) {
    return { strategy: explicit, provider: instantiateProvider(explicit.provider, cfg) };
  }
  // Fallback on the default provider. Model must be declared somewhere — we
  // require the default provider to either have an entry for every strategy
  // or rely on a strategy-default-model field; for now fall back to the first
  // declared strategy's model for the default provider, or an explicit default.
  const fallback: StrategyConfig = {
    provider: cfg.defaultProvider,
    model: findDefaultModelFor(cfg.defaultProvider, cfg),
  };
  return { strategy: fallback, provider: instantiateProvider(cfg.defaultProvider, cfg) };
}

function findDefaultModelFor(providerId: string, cfg: LLMConfig): string {
  for (const s of Object.values(cfg.strategies)) {
    if (s.provider === providerId) return s.model;
  }
  throw new Error(
    `No model available for fallback to default provider "${providerId}" — declare at least one strategy using it, or add an explicit entry in llm.config.json`,
  );
}

function getOrCreate<T>(id: StrategyId, cap: LLMCapability, factory: () => T): T {
  const key: CallCacheKey = `${id}:${cap}`;
  const override = testOverrides.get(key);
  if (override !== undefined) return override as T;
  const cached = callCache.get(key);
  if (cached !== undefined) return cached as T;
  const created = factory();
  callCache.set(key, created);
  return created;
}

export function getStrategyLLM(id: StrategyId): LLMCall {
  const cfg = loadLLMConfig();
  validateCapabilities(cfg);
  return getOrCreate(id, 'text', () => {
    const { strategy, provider } = resolveStrategy(id, cfg);
    return provider.text(strategy);
  });
}

export function getStrategyStructuredLLM<T = unknown>(
  id: StrategyId,
  schema: Record<string, unknown>,
): StructuredLLMCall<T> {
  const cfg = loadLLMConfig();
  validateCapabilities(cfg);
  return getOrCreate(id, 'structured', () => {
    const { strategy, provider } = resolveStrategy(id, cfg);
    return provider.structured<T>(strategy, schema);
  });
}

export function getStrategyLogprobLLM(id: StrategyId): LogprobLLMCall {
  const cfg = loadLLMConfig();
  validateCapabilities(cfg);
  return getOrCreate(id, 'logprobs', () => {
    const { strategy, provider } = resolveStrategy(id, cfg);
    return provider.logprobs(strategy);
  });
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Test-only: inject a stub for a given (strategy, capability) pair. */
export function setLLMCallForTesting(id: StrategyId, cap: LLMCapability, fn: unknown): void {
  testOverrides.set(`${id}:${cap}`, fn);
}

/** Test-only: clear all stubs and cached calls. Usually paired with resetLLMConfigCache. */
export function resetLLMRegistryCache(): void {
  callCache.clear();
  providerCache.clear();
  testOverrides.clear();
  validated = false;
}
