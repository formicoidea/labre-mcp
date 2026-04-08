// Solution strategy registry: auto-discovers all solution strategy files.
//
// Adding a new solution evaluation strategy requires ONLY creating a new
// file in src/solution-strategies/ that exports a class extending
// SolutionBaseStrategy. No modifications to this file or any other
// existing code are needed.
//
// Discovery rules:
//   - Scans src/solution-strategies/*-strategy.mjs at runtime
//   - Skips solution-base-strategy.mjs (the abstract interface)
//   - Each file must export a class extending SolutionBaseStrategy
//   - Strategies are keyed by their static `method` property
//
// This mirrors the capability registry at src/strategies/registry.mjs.

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { SolutionBaseStrategy } from './solution-base-strategy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {Map<string, typeof SolutionBaseStrategy> | null} */
let _cache = null;

/**
 * Discover and load all solution strategy classes from this directory.
 * Results are cached after first call. Use `clearCache()` for testing.
 *
 * @returns {Promise<Map<string, typeof SolutionBaseStrategy>>} Map of method -> StrategyClass
 */
export async function loadSolutionStrategies() {
  if (_cache) return _cache;

  const entries = await readdir(__dirname);
  const strategyFiles = entries.filter(
    f => f.endsWith('-strategy.mjs') && f !== 'solution-base-strategy.mjs'
  );

  /** @type {Map<string, typeof SolutionBaseStrategy>} */
  const strategies = new Map();

  for (const file of strategyFiles) {
    const fullPath = join(__dirname, file);
    const mod = await import(pathToFileURL(fullPath).href);

    // Find the exported class that extends SolutionBaseStrategy
    for (const exportName of Object.keys(mod)) {
      const Cls = mod[exportName];
      if (
        typeof Cls === 'function' &&
        Cls.prototype instanceof SolutionBaseStrategy &&
        Cls !== SolutionBaseStrategy
      ) {
        const method = Cls.method; // static getter
        if (strategies.has(method)) {
          throw new Error(
            `Duplicate solution strategy method "${method}" in ${file} — already registered`
          );
        }
        strategies.set(method, Cls);
      }
    }
  }

  _cache = strategies;
  return strategies;
}

/**
 * Get a single solution strategy by method name.
 * @param {string} method
 * @returns {Promise<typeof SolutionBaseStrategy>}
 */
export async function getSolutionStrategy(method) {
  const strategies = await loadSolutionStrategies();
  const Cls = strategies.get(method);
  if (!Cls) {
    const available = [...strategies.keys()].join(', ');
    throw new Error(
      `Unknown solution strategy "${method}". Available: ${available || '(none)'}`
    );
  }
  return Cls;
}

/**
 * List all available solution strategy method names.
 * @returns {Promise<string[]>}
 */
export async function listSolutionStrategies() {
  const strategies = await loadSolutionStrategies();
  return [...strategies.keys()];
}

/**
 * Clear the solution strategy cache. Useful for testing dynamic registration.
 */
export function clearSolutionCache() {
  _cache = null;
}
