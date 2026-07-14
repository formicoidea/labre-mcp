// Registry — single entry point to obtain an LLM call for a given MCP strategy.
//
// Lookup path:
//   1. loadLLMConfig() returns the validated LLMConfig
//   2. resolveStrategy() resolves the strategy entry (falling back to
//      defaultProvider) and instantiates its provider
//   3. the resolved provider is asserted to support the capability this call
//      needs — implied by which getter the caller used (text / structured /
//      logprobs)
//   4. a cached call instance is returned
//
// The (strategy → required capability) contract lives at the CALL SITE: each
// strategy asks for exactly the capability it needs by calling the matching
// getter. lib/llm therefore stays domain-agnostic — it never enumerates the
// business strategy catalogue, it only resolves opaque string ids. Validation
// is per-strategy and lazy (on first resolution), so a strategy that is never
// called never blocks, and a misconfigured one fails the moment it is used.

import { loadLLMConfig } from './config.loader.mjs';
import type { LLMConfig, ProviderConfig, ProviderKind, StrategyConfig } from './config.schema.mjs';
import { createAgentSdkProvider } from './providers/agent-sdk-provider.mjs';
import { createHttpApiProvider } from './providers/http-api-provider.mjs';
import { createCopilotSdkProvider } from './providers/copilot-sdk-provider.mjs';
import type { LLMCapability, LLMProvider } from './providers/provider.types.mjs';
import type { LLMCall, StructuredLLMCall, LogprobLLMCall } from '../../types/llm.mjs';

type CallCacheKey = `${string}:${LLMCapability}`;
const callCache = new Map<CallCacheKey, unknown>();
const providerCache = new Map<string, LLMProvider>();
const testOverrides = new Map<CallCacheKey, unknown>();

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

function resolveStrategy(
  id: string,
  cfg: LLMConfig,
): { strategy: StrategyConfig; provider: LLMProvider; providerId: string } {
  const explicit = cfg.strategies[id];
  if (explicit) {
    return {
      strategy: explicit,
      provider: instantiateProvider(explicit.provider, cfg),
      providerId: explicit.provider,
    };
  }
  // Fallback on the default provider. Model must be declared somewhere — we
  // require the default provider to either have an entry for every strategy
  // or rely on a strategy-default-model field; for now fall back to the first
  // declared strategy's model for the default provider, or an explicit default.
  const fallback: StrategyConfig = {
    provider: cfg.defaultProvider,
    model: findDefaultModelFor(cfg.defaultProvider, cfg),
  };
  return {
    strategy: fallback,
    provider: instantiateProvider(cfg.defaultProvider, cfg),
    providerId: cfg.defaultProvider,
  };
}

function findDefaultModelFor(providerId: string, cfg: LLMConfig): string {
  for (const s of Object.values(cfg.strategies)) {
    if (s.provider === providerId) return s.model;
  }
  throw new Error(
    `No model available for fallback to default provider "${providerId}" — declare at least one strategy using it, or add an explicit entry in llm.config.json`,
  );
}

// The resolved provider must support the capability this call needs. Kept here
// (not in a central per-strategy table) so the check travels with the actual
// call: the strategy declared its need by choosing this getter.
function assertSupports(
  id: string,
  cap: LLMCapability,
  providerId: string,
  cfg: LLMConfig,
  provider: LLMProvider,
): void {
  if (!provider.supports[cap]) {
    throw new Error(
      `Strategy "${id}" requires capability "${cap}" but provider "${providerId}" (${cfg.providers[providerId].kind}) does not support it`,
    );
  }
}

function getOrCreate<T>(id: string, cap: LLMCapability, factory: () => T): T {
  const key: CallCacheKey = `${id}:${cap}`;
  const override = testOverrides.get(key);
  if (override !== undefined) return override as T;
  const cached = callCache.get(key);
  if (cached !== undefined) return cached as T;
  const created = factory();
  callCache.set(key, created);
  return created;
}

function callFor<T>(id: string, cap: LLMCapability, make: (s: StrategyConfig, p: LLMProvider) => T): T {
  const cfg = loadLLMConfig();
  return getOrCreate(id, cap, () => {
    const { strategy, provider, providerId } = resolveStrategy(id, cfg);
    assertSupports(id, cap, providerId, cfg, provider);
    return make(strategy, provider);
  });
}

export function getStrategyLLM(id: string): LLMCall {
  return callFor(id, 'text', (strategy, provider) => provider.text(strategy));
}

export function getStrategyStructuredLLM<T = unknown>(
  id: string,
  schema: Record<string, unknown>,
): StructuredLLMCall<T> {
  return callFor(id, 'structured', (strategy, provider) => provider.structured<T>(strategy, schema));
}

export function getStrategyLogprobLLM(id: string): LogprobLLMCall {
  return callFor(id, 'logprobs', (strategy, provider) => provider.logprobs(strategy));
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Test-only: inject a stub for a given (strategy, capability) pair. */
export function setLLMCallForTesting(id: string, cap: LLMCapability, fn: unknown): void {
  testOverrides.set(`${id}:${cap}`, fn);
}

/** Test-only: clear all stubs and cached calls. Usually paired with resetLLMConfigCache. */
export function resetLLMRegistryCache(): void {
  callCache.clear();
  providerCache.clear();
  testOverrides.clear();
}
