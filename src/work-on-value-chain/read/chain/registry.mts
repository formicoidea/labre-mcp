// Strategy registry for read:chain:* strategies.
//
// Auto-discovers all *-strategy.{mjs,mts} files in this directory that export
// a class extending BaseChainReadStrategy. Pattern mirrors
// src/work-on-evolution/write/strategies/capacity/registry.mts.

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { BaseChainReadStrategy } from './base-strategy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type StrategyCtor = (new (...args: any[]) => BaseChainReadStrategy) & {
  method: string;
  disabled?: boolean | { reason: string };
};

let _cache: Map<string, StrategyCtor> | null = null;
let _disabledCache: Map<string, { reason: string }> | null = null;

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

    for (const exportName of Object.keys(mod)) {
      const candidate = mod[exportName];
      if (
        typeof candidate === 'function' &&
        (candidate as Function).prototype instanceof BaseChainReadStrategy &&
        candidate !== BaseChainReadStrategy
      ) {
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

export async function listDisabled(): Promise<Array<{ method: string; reason: string }>> {
  await loadStrategies();
  return [..._disabledCache!.entries()].map(([method, { reason }]) => ({ method, reason }));
}

export async function isDisabled(method: string): Promise<boolean> {
  await loadStrategies();
  return _disabledCache!.has(method);
}

export async function getStrategy(method: string): Promise<StrategyCtor> {
  const strategies = await loadStrategies();
  const Cls = strategies.get(method);
  if (!Cls) {
    if (_disabledCache && _disabledCache.has(method)) {
      const { reason } = _disabledCache.get(method)!;
      throw new Error(`Strategy "${method}" is disabled: ${reason}`);
    }
    const available = [...strategies.keys()].join(', ') || '(none registered)';
    throw new Error(`Unknown strategy "${method}". Available: ${available}`);
  }
  return Cls;
}

export async function listStrategies(): Promise<string[]> {
  const strategies = await loadStrategies();
  return [...strategies.keys()];
}

export function clearCache(): void {
  _cache = null;
  _disabledCache = null;
}
