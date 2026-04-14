// Solution strategy registry: auto-discovers all solution strategy files.
//
// Adding a new solution evaluation strategy requires ONLY creating a new
// file in src/strategies/solution/ that exports a class extending
// SolutionBaseStrategy. No modifications to this file or any other
// existing code are needed.
//
// Discovery rules:
//   - Scans *-strategy.{mjs,mts} at runtime (mts in dev via tsx, mjs in dist)
//   - Skips solution-base-strategy.* (the abstract interface)
//   - Each file must export a class extending SolutionBaseStrategy
//   - Strategies are keyed by their static `method` property
//
// This mirrors the capability registry in ../capacity/registry.mts.

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { SolutionBaseStrategy } from './solution-base-strategy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Constructor type for solution strategy classes. The dynamic import cannot be
 *  statically typed, so we narrow after an `instanceof SolutionBaseStrategy` guard. */
export type SolutionStrategyCtor = (new (...args: any[]) => SolutionBaseStrategy) & {
  method: string;
};

let _cache: Map<string, SolutionStrategyCtor> | null = null;

/**
 * Discover and load all solution strategy classes from this directory.
 * Results are cached after first call. Use `clearSolutionCache()` for testing.
 */
export async function loadSolutionStrategies(): Promise<Map<string, SolutionStrategyCtor>> {
  if (_cache) return _cache;

  const entries = await readdir(__dirname);
  const strategyFiles = entries.filter(
    f =>
      (f.endsWith('-strategy.mjs') || f.endsWith('-strategy.mts')) &&
      f !== 'solution-base-strategy.mjs' &&
      f !== 'solution-base-strategy.mts',
  );

  const strategies = new Map<string, SolutionStrategyCtor>();

  for (const file of strategyFiles) {
    const fullPath = join(__dirname, file);
    const mod = await import(pathToFileURL(fullPath).href) as Record<string, unknown>;

    for (const exportName of Object.keys(mod)) {
      const candidate = mod[exportName];
      if (
        typeof candidate === 'function' &&
        (candidate as Function).prototype instanceof SolutionBaseStrategy &&
        candidate !== SolutionBaseStrategy
      ) {
        const Cls = candidate as unknown as SolutionStrategyCtor;
        const method = Cls.method;
        if (strategies.has(method)) {
          throw new Error(
            `Duplicate solution strategy method "${method}" in ${file} — already registered`,
          );
        }
        strategies.set(method, Cls);
      }
    }
  }

  _cache = strategies;
  return strategies;
}

/** Get a single solution strategy by method name. */
export async function getSolutionStrategy(method: string): Promise<SolutionStrategyCtor> {
  const strategies = await loadSolutionStrategies();
  const Cls = strategies.get(method);
  if (!Cls) {
    const available = [...strategies.keys()].join(', ');
    throw new Error(
      `Unknown solution strategy "${method}". Available: ${available || '(none)'}`,
    );
  }
  return Cls;
}

/** List all available solution strategy method names. */
export async function listSolutionStrategies(): Promise<string[]> {
  const strategies = await loadSolutionStrategies();
  return [...strategies.keys()];
}

/** Clear the solution strategy cache. Useful for testing dynamic registration. */
export function clearSolutionCache(): void {
  _cache = null;
}
