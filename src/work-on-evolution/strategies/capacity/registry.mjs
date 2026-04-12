// Strategy registry: auto-discovers all strategy files in this directory.
//
// Adding a new evaluation strategy requires ONLY creating a new file in
// src/strategies/ that exports a class extending BaseStrategy.
// No modifications to this file or any other existing code are needed.
//
// Discovery rules:
//   - Scans src/strategies/*-strategy.mjs at runtime
//   - Skips base-strategy.mjs (the abstract interface)
//   - Each file must export a class extending BaseStrategy
//   - Strategies are keyed by their static `method` property

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { BaseStrategy } from './base-strategy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {Map<string, typeof BaseStrategy> | null} */
let _cache = null;
/** @type {Map<string, { reason: string }> | null} */
let _disabledCache = null;

/**
 * Discover and load all strategy classes from this directory.
 * Results are cached after first call. Use `clearCache()` for testing.
 *
 * @returns {Promise<Map<string, typeof BaseStrategy>>} Map of method → StrategyClass
 */
export async function loadStrategies() {
  if (_cache) return _cache;

  const entries = await readdir(__dirname);
  const strategyFiles = entries.filter(
    f => f.endsWith('-strategy.mjs') && f !== 'base-strategy.mjs'
  );

  /** @type {Map<string, typeof BaseStrategy>} */
  const strategies = new Map();

  for (const file of strategyFiles) {
    const fullPath = join(__dirname, file);
    const mod = await import(pathToFileURL(fullPath).href);

    // Find the exported class that extends BaseStrategy
    for (const exportName of Object.keys(mod)) {
      const Cls = mod[exportName];
      if (
        typeof Cls === 'function' &&
        Cls.prototype instanceof BaseStrategy &&
        Cls !== BaseStrategy
      ) {
        const method = Cls.method; // static getter
        if (strategies.has(method)) {
          throw new Error(
            `Duplicate strategy method "${method}" in ${file} — already registered`
          );
        }
        strategies.set(method, Cls);
      }
    }
  }

  // Partition: strategies that declare `static get disabled` truthy are
  // excluded from the active map and recorded in the disabled map.
  /** @type {Map<string, { reason: string }>} */
  const disabled = new Map();
  for (const [method, Cls] of [...strategies]) {
    const flag = Cls.disabled;
    if (flag) {
      const reason = (flag && typeof flag === 'object' && typeof flag.reason === 'string')
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

/**
 * List all disabled strategies with their reasons.
 * @returns {Promise<Array<{ method: string, reason: string }>>}
 */
export async function listDisabled() {
  await loadStrategies();
  return [..._disabledCache.entries()].map(([method, { reason }]) => ({ method, reason }));
}

/**
 * Check whether a given method name refers to a disabled strategy.
 * @param {string} method
 * @returns {Promise<boolean>}
 */
export async function isDisabled(method) {
  await loadStrategies();
  return _disabledCache.has(method);
}

/**
 * Get a single strategy by method name.
 * @param {string} method
 * @returns {Promise<typeof BaseStrategy>}
 */
export async function getStrategy(method) {
  const strategies = await loadStrategies();
  const Cls = strategies.get(method);
  if (!Cls) {
    if (_disabledCache && _disabledCache.has(method)) {
      const { reason } = _disabledCache.get(method);
      throw new Error(`Strategy "${method}" is disabled: ${reason}`);
    }
    const available = [...strategies.keys()].join(', ');
    throw new Error(
      `Unknown strategy "${method}". Available: ${available}`
    );
  }
  return Cls;
}

/**
 * List all available strategy method names.
 * @returns {Promise<string[]>}
 */
export async function listStrategies() {
  const strategies = await loadStrategies();
  return [...strategies.keys()];
}

/**
 * Clear the strategy cache. Useful for testing dynamic registration.
 */
export function clearCache() {
  _cache = null;
  _disabledCache = null;
}
