// Loader for prompts.config.json.
//
// Resolution order:
//   1. process.env.WARDLEY_PROMPTS_CONFIG (absolute or project-relative path)
//   2. <project root>/prompts.config.json
//
// For every `template`-kind entry, reads the referenced templateFile from disk,
// normalizes CRLF → LF (indispensable on Windows so the prompt matches what the
// JS constant used to emit), validates that declared `variables[]` exactly
// matches the {{var}} placeholders found in the template, and stores the
// normalized text alongside the entry metadata.
//
// Cross-validation with llm.config.json is intentionally *soft*: prompts for
// strategies that have no LLM config entry are accepted (some prompts are
// shared infrastructure consumed via injected llmCall by a parent strategy).

import { readFileSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { validateOrThrow } from '#lib/zod/validate-or-throw.mjs';
import {
  PromptsConfigSchema,
  isSplitTemplateFile,
  type PromptsConfig,
  type PromptEntry,
} from './prompts.schema.mjs';

export interface ResolvedTemplate {
  /** User-message text (variables allowed here). */
  text: string;
  /** Optional system-message text — present only for split templates.
   *  Must be invariant (no {{...}} placeholders). */
  system?: string;
  variables: readonly string[];
}

export interface LoadedPrompts {
  /** Validated raw config (references to templateFile, not their content). */
  config: PromptsConfig;
  /** strategyId → promptName → resolved template text (CRLF-normalized).
   *  Missing for `function`-kind entries. */
  templates: Record<string, Record<string, ResolvedTemplate>>;
}

let cached: LoadedPrompts | undefined;
let cachedPath: string | undefined;

function resolveConfigPath(): string {
  const override = process.env.WARDLEY_PROMPTS_CONFIG;
  if (override) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  return resolve(process.cwd(), 'prompts.config.json');
}

function extractTemplateVars(text: string): string[] {
  const found = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1]);
  }
  return [...found].sort();
}

function validateVariables(
  strategy: string,
  name: string,
  templateVars: string[],
  declaredVars: readonly string[],
): void {
  const declared = [...declaredVars].sort();
  const template = [...templateVars].sort();
  const missing = template.filter(v => !declared.includes(v));
  const extra = declared.filter(v => !template.includes(v));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length) parts.push(`template uses ${JSON.stringify(missing)} not declared in variables[]`);
    if (extra.length) parts.push(`variables[] declares ${JSON.stringify(extra)} not used in template`);
    throw new Error(
      `Prompt "${strategy}/${name}": ${parts.join('; ')}`,
    );
  }
}

export function loadPromptsConfig(): LoadedPrompts {
  if (cached) return cached;
  const path = resolveConfigPath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read prompts config at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in prompts config at ${path}: ${(err as Error).message}`);
  }

  const config = validateOrThrow(PromptsConfigSchema, parsed, `Prompts config at ${path}`);
  const configDir = dirname(path);
  const templates: Record<string, Record<string, ResolvedTemplate>> = {};

  for (const [strategy, prompts] of Object.entries(config)) {
    templates[strategy] = {};
    for (const [name, entry] of Object.entries(prompts)) {
      if ((entry as PromptEntry).kind !== 'template') continue;
      const tEntry = entry as Extract<PromptEntry, { kind: 'template' }>;

      if (isSplitTemplateFile(tEntry.templateFile)) {
        templates[strategy][name] = loadSplitTemplate(
          strategy,
          name,
          tEntry.templateFile,
          tEntry.variables,
          configDir,
        );
      } else {
        templates[strategy][name] = loadLegacyTemplate(
          strategy,
          name,
          tEntry.templateFile,
          tEntry.variables,
          configDir,
        );
      }
    }
  }

  cached = { config, templates };
  cachedPath = path;
  return cached;
}

function readTemplateFile(
  strategy: string,
  name: string,
  role: 'template' | 'system' | 'user',
  relativePath: string,
  configDir: string,
): string {
  const full = isAbsolute(relativePath) ? relativePath : resolve(configDir, relativePath);
  try {
    // Normalize CRLF → LF for Windows parity with the JS string constants
    // the registry used before templates moved to disk.
    return readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
  } catch (err) {
    throw new Error(
      `Prompt "${strategy}/${name}": cannot read ${role} file ${full}: ${(err as Error).message}`,
    );
  }
}

function loadLegacyTemplate(
  strategy: string,
  name: string,
  templateFile: string,
  declaredVars: readonly string[],
  configDir: string,
): ResolvedTemplate {
  const text = readTemplateFile(strategy, name, 'template', templateFile, configDir);
  validateVariables(strategy, name, extractTemplateVars(text), declaredVars);
  return { text, variables: declaredVars };
}

function loadSplitTemplate(
  strategy: string,
  name: string,
  templateFile: { system: string; user: string },
  declaredVars: readonly string[],
  configDir: string,
): ResolvedTemplate {
  const system = readTemplateFile(strategy, name, 'system', templateFile.system, configDir);
  const user = readTemplateFile(strategy, name, 'user', templateFile.user, configDir);

  // System content must be invariant — caching and role separation only work
  // when the system stays byte-identical across calls.
  const systemVars = extractTemplateVars(system);
  if (systemVars.length > 0) {
    throw new Error(
      `Prompt "${strategy}/${name}": system file must not contain {{...}} placeholders ` +
      `(found: ${JSON.stringify(systemVars)}). Move variable content to the user file.`,
    );
  }

  // User file must declare exactly the variables listed in the config.
  validateVariables(strategy, name, extractTemplateVars(user), declaredVars);

  return { text: user, system, variables: declaredVars };
}

export function getLoadedPromptsConfigPath(): string | undefined {
  return cachedPath;
}

/** Test-only: clear the memoized config so the next call re-reads from disk. */
export function resetPromptsConfigCache(): void {
  cached = undefined;
  cachedPath = undefined;
}
