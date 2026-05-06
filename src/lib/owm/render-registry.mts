// Singleton registry for the active OwmRenderAdapter. Mirrors the
// pattern used by src/lib/llm/registry.mts and the parsers/builders
// registries in src/lib/prompts/ — config-driven default + lazy cache
// + explicit reset/override hooks for tests.

import { CliOwmAdapter } from './cli-owm-adapter.mjs';
import type { OwmRenderAdapter } from './render-adapter.mjs';

let cached: OwmRenderAdapter | null = null;

/**
 * Resolve the OwmRenderAdapter used by the running pipeline. First
 * call instantiates the default adapter (cli-owm) and caches it; later
 * calls reuse the cached instance. Tests should override via
 * `setRenderAdapterForTesting()` before any consumer code runs.
 */
export function getRenderAdapter(): OwmRenderAdapter {
  if (cached !== null) return cached;
  cached = new CliOwmAdapter();
  return cached;
}

/** Inject a mock adapter for tests. Replaces the cached instance. */
export function setRenderAdapterForTesting(adapter: OwmRenderAdapter): void {
  cached = adapter;
}

/** Drop the cached adapter so the next `getRenderAdapter()` call
 *  rebuilds from scratch. Use between tests to isolate state. */
export function resetRenderAdapterCache(): void {
  cached = null;
}
