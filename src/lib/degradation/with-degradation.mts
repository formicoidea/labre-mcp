// `tryDegrade` — functional helper that replaces silent `try/catch {}`
// blocks around external calls. On success it returns the value; on failure
// it records a degradation event on the collector and returns the fallback.

import type { DegradationSeverity } from './types.mjs';
import { DegradationCollector } from './collector.mjs';
import { getCurrentCollector } from './context.mjs';

export interface TryDegradeOptions {
  recoverable?: boolean;
  severity?: DegradationSeverity;
}

/**
 * Execute `fn`. If it throws (or rejects), record the error on `collector`
 * under `source` and return `fallback` instead.
 *
 * The fallback is returned as-is — the caller is responsible for choosing
 * a value that keeps the surrounding pipeline valid (empty arrays, neutral
 * scores, stub objects, ...).
 *
 * @example
 *   const patentData = await tryDegrade(
 *     collector, 'bigquery',
 *     () => createPatentSource().fetchByCpc(cpcCodes),
 *     { totalPatents: 0, patents: [] },
 *   );
 */
export async function tryDegrade<T>(
  collector: DegradationCollector,
  source: string,
  fn: () => Promise<T> | T,
  fallback: T,
  opts: TryDegradeOptions = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    collector.recordError(source, err, opts);
    return fallback;
  }
}

/**
 * Same as `tryDegrade` but uses the ambient collector (set by
 * `withMcpDegradation` via AsyncLocalStorage). When no ambient collector
 * exists — typically a unit test or CLI script invocation — the failure
 * is silently swallowed and the fallback is returned.
 *
 * Use this from inside MCP-invoked code paths (strategies, loaders,
 * routers) where threading a collector through every signature would be
 * noise.
 */
export async function tryDegradeAmbient<T>(
  source: string,
  fn: () => Promise<T> | T,
  fallback: T,
  opts: TryDegradeOptions = {},
): Promise<T> {
  const collector = getCurrentCollector();
  if (!collector) {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }
  return tryDegrade(collector, source, fn, fallback, opts);
}
