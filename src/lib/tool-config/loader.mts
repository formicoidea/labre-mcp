// Loader for tool.config.json.
//
// Resolution order:
//   1. process.env.WARDLEY_TOOL_CONFIG (absolute or project-relative path)
//   2. <project root>/tool.config.json
//
// Singleton lazy + memoized. Mirrors the prompts/config.loader pattern.

import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import {
  ToolConfigSchema,
  type ToolConfig,
  type StrategyTypeKey,
  type RoutedMode,
} from './tool-config.schema.mjs';

let cached: ToolConfig | undefined;
let cachedPath: string | undefined;

function resolveConfigPath(): string {
  const override = process.env.WARDLEY_TOOL_CONFIG;
  if (override) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  return resolve(process.cwd(), 'tool.config.json');
}

export function loadToolConfig(): ToolConfig {
  if (cached) return cached;
  const path = resolveConfigPath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read tool config at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in tool config at ${path}: ${(err as Error).message}`);
  }

  const result = ToolConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map(i => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Tool config at ${path} failed validation:\n${details}`);
  }

  cached = result.data;
  cachedPath = path;
  return cached;
}

export function resolveStrategyForType(mode: 'auto', type: StrategyTypeKey): string;
export function resolveStrategyForType(mode: 'report', type: StrategyTypeKey): readonly string[];
export function resolveStrategyForType(
  mode: RoutedMode,
  type: StrategyTypeKey,
): string | readonly string[] {
  const config = loadToolConfig();
  if (mode === 'auto') return config.estimateEvolution.auto[type];
  return config.estimateEvolution.report[type];
}

export function getLoadedToolConfigPath(): string | undefined {
  return cachedPath;
}

/** Test-only: clear the memoized config so the next call re-reads from disk. */
export function resetToolConfigCache(): void {
  cached = undefined;
  cachedPath = undefined;
}
