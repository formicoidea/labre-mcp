// Loader for the unified LLM config file.
//
// Resolution order:
//   1. process.env.WARDLEY_LLM_CONFIG (absolute or project-relative path)
//   2. <project root>/llm.config.json
//
// Parsed once per process and cached. Use resetLLMConfigCache() in tests.

import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { validateOrThrow } from '#lib/zod/validate-or-throw.mjs';
import { LLMConfigSchema, type LLMConfig } from './config.schema.mjs';

let cached: LLMConfig | undefined;
let cachedPath: string | undefined;

function resolveConfigPath(): string {
  const override = process.env.WARDLEY_LLM_CONFIG;
  if (override) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  return resolve(process.cwd(), 'llm.config.json');
}

export function loadLLMConfig(): LLMConfig {
  if (cached) return cached;
  const path = resolveConfigPath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read LLM config at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in LLM config at ${path}: ${(err as Error).message}`);
  }

  cached = validateOrThrow(LLMConfigSchema, parsed, `LLM config at ${path}`);
  cachedPath = path;
  return cached;
}

export function getLoadedConfigPath(): string | undefined {
  return cachedPath;
}

/** Test-only: clear the memoized config so the next call re-reads from disk. */
export function resetLLMConfigCache(): void {
  cached = undefined;
  cachedPath = undefined;
}
