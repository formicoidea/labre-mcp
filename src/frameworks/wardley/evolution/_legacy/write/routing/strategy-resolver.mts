// Translates a surface-level `strategy` value (passed via the MCP estimateEvolution
// tool) into a concrete dispatch plan for the routing layer.
//
// Surface values:
//   - 'auto'     → router picks ONE strategy per detected type (read from tool.config.json#auto)
//   - 'report'   → router picks SEVERAL strategies per detected type (from tool.config.json#report)
//   - <specific> → method id passed straight through (e.g. 'write:capacity:s-curve')
//
// Anchor-typed components are intercepted upstream and never reach this resolver
// (handled directly in mode-router via the explicit anchor branch).

import { resolveStrategyForType } from '#lib/tool-config/loader.mjs';
import type { StrategyTypeKey } from '#lib/tool-config/tool-config.schema.mjs';

export type ResolvedStrategy =
  | { kind: 'single'; method: string }
  | { kind: 'multi'; methods: readonly string[] }
  | { kind: 'specific'; method: string };

/**
 * Resolve a surface `strategy` for a detected component type (capability or
 * solution). Returns the dispatch plan the caller should execute.
 *
 * Throws when `strategy` is empty or invalid (caller must default to 'auto'
 * before calling this function).
 */
export function resolveStrategy(
  strategy: string,
  detectedType: Exclude<StrategyTypeKey, 'anchor'>,
): ResolvedStrategy {
  if (!strategy) {
    throw new Error(`resolveStrategy: empty strategy for type "${detectedType}"`);
  }

  if (strategy === 'auto') {
    return { kind: 'single', method: resolveStrategyForType('auto', detectedType) };
  }

  if (strategy === 'report') {
    return { kind: 'multi', methods: resolveStrategyForType('report', detectedType) };
  }

  // Specific method id passed by an expert caller — pass through unchanged.
  return { kind: 'specific', method: strategy };
}
