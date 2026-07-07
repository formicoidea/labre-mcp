// Per-invocation prompt-override context using Node's AsyncLocalStorage.
//
// A run-scoped store lets an active bundle (A/B testing) shadow the shipped
// prompts.config.json for the duration of one call tree, WITHOUT mutating the
// module-global registry cache. Any code reachable from the run — notably the
// prompt registry's getPrompt() — consults the store via
// `getCurrentPromptOverrides()` and falls back to shipped prompts when it is
// absent.
//
// Same idiom as lib/degradation/context.mts: the store is optional. Code that
// runs outside an override run (the default MCP path, unit tests, CLI scripts)
// sees `undefined` and resolves shipped prompts exactly as before.

import { AsyncLocalStorage } from 'node:async_hooks';

/** One split prompt pair. The system message is invariant (no {{...}}
 *  placeholders) — validated where the pair is produced (bundle loader).
 *  Declared here so the prompts lib owns the type and never depends on the
 *  bundles lib; bundle-loader re-exports it. */
export interface BundlePromptPair {
  /** Invariant system message — guaranteed free of {{...}} placeholders. */
  system: string;
  /** User message template — {{var}} placeholders allowed. */
  user: string;
}

/** Run-scoped prompt overrides layered over the shipped config. */
export interface PromptOverrideStore {
  /** strategyId → promptName → pair that shadows the shipped prompt. */
  prompts: Record<string, Record<string, BundlePromptPair>>;
  /** strategyId → selected variant name. Carried for a later checkpoint that
   *  resolves which variant's prompts populate `prompts`; unused here. */
  activeVariants?: Record<string, string>;
}

const storage = new AsyncLocalStorage<PromptOverrideStore>();

/**
 * Run `fn` with `store` available to every async call below it, so the prompt
 * registry can shadow shipped prompts for the duration of this call tree.
 */
export function runWithPromptOverrides<T>(
  store: PromptOverrideStore,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return storage.run(store, fn);
}

/**
 * Return the override store for the current async context, or `undefined`
 * when no override run is in flight (the default path — resolve shipped
 * prompts).
 */
export function getCurrentPromptOverrides(): PromptOverrideStore | undefined {
  return storage.getStore();
}
