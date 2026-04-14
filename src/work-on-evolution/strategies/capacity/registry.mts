// Strategy registry: auto-discovers all strategy files in this directory.
//
// Adding a new evaluation strategy requires ONLY creating a new file in
// src/strategies/ that exports a class extending BaseStrategy.
// No modifications to this file or any other existing code are needed.
//
// Discovery rules:
//   - Scans *-strategy.{mjs,mts} at runtime (mts in dev via tsx, mjs in dist)
//   - Skips base-strategy.* (the abstract interface)
//   - Each file must export a class extending BaseStrategy
//   - Strategies are keyed by their static `method` property

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { BaseStrategy } from './base-strategy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Constructor type for strategy classes. The dynamic import cannot be statically
 *  typed, so we narrow to this shape after an `instanceof BaseStrategy` guard. */
export type StrategyCtor = (new (...args: any[]) => BaseStrategy) & {
  method: string;
  disabled?: boolean | { reason: string };
};

let _cache: Map<string, StrategyCtor> | null = null;
let _disabledCache: Map<string, { reason: string }> | null = null;

/**
 * Discover and load all strategy classes from this directory.
 * Results are cached after first call. Use `clearCache()` for testing.
 */
export async function loadStrategies(): Promise<Map<string, StrategyCtor>> {
  if (_cache) return _cache;

  const entries = await readdir(__dirname);
  const strategyFiles = entries.filter(
    f =>
      (f.endsWith('-strategy.mjs') || f.endsWith('-strategy.mts')) &&
      f !== 'base-strategy.mjs' &&
      f !== 'base-strategy.mts',
  );

  const strategies = new Map<string, StrategyCtor>();

  for (const file of strategyFiles) {
    const fullPath = join(__dirname, file);
    const mod = await import(pathToFileURL(fullPath).href) as Record<string, unknown>;

    // Find the exported class that extends BaseStrategy
    for (const exportName of Object.keys(mod)) {
      const candidate = mod[exportName];
      if (
        typeof candidate === 'function' &&
        (candidate as Function).prototype instanceof BaseStrategy &&
        candidate !== BaseStrategy
      ) {
        // Safe to narrow: we verified it's a constructor extending BaseStrategy.
        const Cls = candidate as unknown as StrategyCtor;
        const method = Cls.method;
        if (strategies.has(method)) {
          throw new Error(
            `Duplicate strategy method "${method}" in ${file} — already registered`,
          );
        }
        strategies.set(method, Cls);
      }
    }
  }

  // Partition: strategies that declare `static get disabled` truthy are
  // excluded from the active map and recorded in the disabled map.
  const disabled = new Map<string, { reason: string }>();
  for (const [method, Cls] of [...strategies]) {
    const flag = Cls.disabled;
    if (flag) {
      const reason =
        flag && typeof flag === 'object' && typeof flag.reason === 'string'
          ? flag.reason
          : 'disabled';
      disabled.set(method, { reason });
      strategies.delete(method);
    }
  }

  _cache = strategies;
  _disabledCache = disabled;
  return strategies;
}

/** List all disabled strategies with their reasons. */
export async function listDisabled(): Promise<Array<{ method: string; reason: string }>> {
  await loadStrategies();
  return [..._disabledCache!.entries()].map(([method, { reason }]) => ({ method, reason }));
}

/** Check whether a given method name refers to a disabled strategy. */
export async function isDisabled(method: string): Promise<boolean> {
  await loadStrategies();
  return _disabledCache!.has(method);
}

/** Get a single strategy by method name. */
export async function getStrategy(method: string): Promise<StrategyCtor> {
  const strategies = await loadStrategies();
  const Cls = strategies.get(method);
  if (!Cls) {
    if (_disabledCache && _disabledCache.has(method)) {
      const { reason } = _disabledCache.get(method)!;
      throw new Error(`Strategy "${method}" is disabled: ${reason}`);
    }
    const available = [...strategies.keys()].join(', ');
    throw new Error(`Unknown strategy "${method}". Available: ${available}`);
  }
  return Cls;
}

/** List all available strategy method names. */
export async function listStrategies(): Promise<string[]> {
  const strategies = await loadStrategies();
  return [...strategies.keys()];
}

/** Clear the strategy cache. Useful for testing dynamic registration. */
export function clearCache(): void {
  _cache = null;
  _disabledCache = null;
}
