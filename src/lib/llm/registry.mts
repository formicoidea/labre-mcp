// Registry — single entry point to obtain an LLM call for a given MCP strategy.
//
// Lookup path:
//   1. loadLLMConfig() returns the validated LLMConfig
//   2. resolveStrategy() resolves the strategy entry (falling back to
//      defaultProvider + defaultModel) and instantiates its provider
//   3. the resolved provider is asserted to support the capability this call
//      needs — implied by which getter the caller used (text / structured /
//      logprobs)
//   4. a cached call instance is returned
//
// Steps 1-4 all live BEHIND the cache/override short-circuit in `getOrCreate`:
// a test override, and a call already resolved once, must never re-read the
// config file. That ordering is load-bearing, not cosmetic — `llm.config.json`
// is per-user and git-ignored, so a fresh clone, a git worktree or a CI runner
// has none. Reading it eagerly made every resolution fail there, INCLUDING the
// ones a test had explicitly stubbed.
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
import { withAiCallSentinel } from './ai-call-sentinel.mjs';
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
  // No entry for this strategy → fall back on the declared default route.
  //
  // The fallback stays available on purpose: strategies without an explicit
  // entry are the norm, not the exception, and requiring one per strategy would
  // make every new strategy a config change. What is NOT acceptable is choosing
  // the model implicitly: `defaultModel` must be declared, or this throws. A
  // config predating the field still loads (the field is optional) and every
  // strategy it DOES declare keeps working — only the fallback path errors, and
  // it says exactly what to add.
  if (cfg.defaultModel === undefined) {
    throw new Error(
      `Strategy "${id}" has no entry in llm.config.json and no fallback model is declared — ` +
        'declare defaultModel or an explicit strategy entry',
    );
  }
  const fallback: StrategyConfig = {
    provider: cfg.defaultProvider,
    model: cfg.defaultModel,
  };
  warnFallbackOnce(id, cfg.defaultProvider, cfg.defaultModel);
  return {
    strategy: fallback,
    provider: instantiateProvider(cfg.defaultProvider, cfg),
    providerId: cfg.defaultProvider,
  };
}

/** strategyIds already reported as unmapped. The call cache alone would nearly
 *  do it — a resolved call is built once — but only nearly: a resolution that
 *  throws downstream (unsupported capability) never reaches the cache and would
 *  warn again on every retry. */
const warnedFallbacks = new Set<string>();

/**
 * Signal ONCE per strategyId that it resolved through the fallback. An unmapped
 * id used to pass in complete silence, which is how a strategy can run for
 * months against a model nobody chose for it. stderr, never stdout: the stdio
 * MCP transport owns stdout and any stray byte there corrupts the protocol.
 */
function warnFallbackOnce(id: string, providerId: string, model: string): void {
  if (warnedFallbacks.has(id)) return;
  warnedFallbacks.add(id);
  console.warn(
    `[llm] strategy "${id}" has no entry in llm.config.json — falling back to ` +
      `provider "${providerId}" / model "${model}". Add a strategies["${id}"] entry to pin it.`,
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
    const kind = cfg.providers[providerId].kind;
    if (cap === 'vision') {
      // Say what is actually missing (an image channel), not "capability
      // vision" — this message reaches the MCP degradation insight verbatim.
      throw new Error(
        `Strategy "${id}" sends images but provider "${providerId}" (${kind}) does not support image input`,
      );
    }
    throw new Error(
      `Strategy "${id}" requires capability "${cap}" but provider "${providerId}" (${kind}) does not support it`,
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

function callFor<T extends (...args: never[]) => unknown>(
  id: string,
  cap: LLMCapability,
  make: (s: StrategyConfig, p: LLMProvider) => T,
): T {
  // Config read INSIDE the factory, so `getOrCreate`'s override/cache
  // short-circuit runs first (see the header comment): stubbing a call must not
  // require an `llm.config.json` on disk.
  return getOrCreate(id, cap, () => {
    const cfg = loadLLMConfig();
    const { strategy, provider, providerId } = resolveStrategy(id, cfg);
    assertSupports(id, cap, providerId, cfg, provider);
    // Sentinel seam: every LLM call the registry hands out is counted, once per
    // invocation (the call itself is cached, the event is not). Test overrides
    // never reach here — getOrCreate short-circuits on them — so a stubbed call
    // stays the exact function the test injected and emits nothing.
    return withAiCallSentinel(make(strategy, provider), {
      strategy: id,
      provider: providerId,
      model: strategy.model,
      capability: cap,
    });
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

/** Text completion that additionally accepts `opts.images`. Throws when the
 *  resolved provider cannot carry an image — never returns a call that would
 *  silently answer about an image the model never received. */
export function getStrategyVisionLLM(id: string): LLMCall {
  return callFor(id, 'vision', (strategy, provider) => provider.vision(strategy));
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
  warnedFallbacks.clear();
}
