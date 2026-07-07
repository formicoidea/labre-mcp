// Loader for strategy bundles (v0).
//
// A bundle is a DATA-ONLY package (manifest.json + recipe.json + optional
// prompts/<strategyId>/<name>.{system,user}.md split pairs) layered on top of
// the shipped primitives — see src/schemas/strategy-bundle.schema.mts for the
// layout contract. This loader validates HARD and throws descriptive Errors
// naming the bundle label and the offending file/field; degradation policy is
// the caller's concern (the Supabase source decides what a failed bundle
// means for a refresh, the local caller for a boot).
//
// The validation core is `loadBundleFromFiles`, which reads bundle files
// through an injected async reader — it never touches the filesystem itself,
// so remote bundles (Supabase Storage) are validated fully IN MEMORY, no temp
// files ever (statelessness: the MCP writes nothing durable).
// `loadBundleFromDir` is the thin local-directory wrapper over it.
//
// Static checks performed at load time:
//   - manifest.json matches StrategyBundleManifestSchema;
//   - recipe.json matches the shipped RecipeSchema (which already enforces the
//     5-segment methodId grammar on every step `tool` via methodIdSchema);
//   - recipe.name === manifest.slug (one recipe per bundle, addressed by slug);
//   - declared prompt pairs imply the "llm" permission;
//   - every declared pair is readable, is CRLF→LF normalized, and its
//     system file is invariant (no {{...}} placeholders — same rule as
//     lib/prompts/config.loader).

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateOrThrow } from '#lib/zod/validate-or-throw.mjs';
import { extractTemplateVars } from '#lib/prompts/config.loader.mjs';
import type { BundlePromptPair } from '#lib/prompts/override-context.mjs';
import { assertBundlePromptsOverridable } from '#lib/prompts/override-validation.mjs';
import {
  StrategyBundleManifestSchema,
  type StrategyBundleManifest,
} from '#schemas/strategy-bundle.schema.mjs';
import { RecipeSchema, type Recipe } from '#core/recipe/recipe.schema.mjs';
import {
  registerBundleRecipe,
  type RegisterBundleRecipeOptions,
} from '#core/recipe/recipe-loader.mjs';

// BundlePromptPair is declared in the prompts lib (the run-scoped override
// store consumes it there) and re-exported here for existing bundle callers.
// Keeps the prompts lib free of any dependency on the bundles lib.
export type { BundlePromptPair };

/** Fully validated bundle content, independent of where it came from. */
export interface ValidatedBundle {
  manifest: StrategyBundleManifest;
  recipe: Recipe;
  /** strategyId → promptName → pair contents (empty record when none declared). */
  prompts: Record<string, Record<string, BundlePromptPair>>;
}

export interface LoadedBundle extends ValidatedBundle {
  /** Absolute directory the bundle was loaded from (error context for callers). */
  dir: string;
}

/**
 * Async reader for one bundle file. `relativePath` is always POSIX-style
 * relative to the bundle root (e.g. "manifest.json",
 * "prompts/demo-strategy/default.system.md"). Must reject when the file
 * cannot be provided — the loader wraps the error with bundle context.
 */
export type BundleFileReader = (relativePath: string) => Promise<string>;

async function readJsonFile(
  label: string,
  read: BundleFileReader,
  fileName: string,
): Promise<unknown> {
  let raw: string;
  try {
    raw = await read(fileName);
  } catch (err) {
    throw new Error(`Bundle ${label}: cannot read ${fileName}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Bundle ${label}: invalid JSON in ${fileName}: ${(err as Error).message}`);
  }
}

async function readPromptFile(
  label: string,
  read: BundleFileReader,
  strategyId: string,
  name: string,
  role: 'system' | 'user',
): Promise<string> {
  // POSIX-style relative path — the dir wrapper's join() accepts forward
  // slashes on every platform, and remote sources are keyed this way.
  const relative = `prompts/${strategyId}/${name}.${role}.md`;
  let raw: string;
  try {
    raw = await read(relative);
  } catch (err) {
    throw new Error(
      `Bundle ${label}: prompt "${strategyId}/${name}": cannot read ${role} file ${relative}: ${(err as Error).message}`,
    );
  }
  // CRLF → LF, same Windows-parity normalization as lib/prompts/config.loader.
  return raw.replace(/\r\n/g, '\n');
}

/**
 * Validation core: load and fully validate a strategy bundle through an
 * injected file reader (in memory — no filesystem assumption, no temp files).
 * `label` names the bundle in every error message (a directory for local
 * loads, "slug@version" for remote ones).
 * Throws on ANY inconsistency — a returned ValidatedBundle is safe to register.
 */
export async function loadBundleFromFiles(
  label: string,
  read: BundleFileReader,
): Promise<ValidatedBundle> {
  const manifest = validateOrThrow(
    StrategyBundleManifestSchema,
    await readJsonFile(label, read, 'manifest.json'),
    `Bundle ${label}: manifest.json`,
  );
  // RecipeSchema enforces the 5-segment methodId grammar on every step.tool.
  const recipe = validateOrThrow(
    RecipeSchema,
    await readJsonFile(label, read, 'recipe.json'),
    `Bundle ${label}: recipe.json`,
  );

  // The bundle's single recipe is addressed by the manifest slug.
  if (recipe.name !== manifest.slug) {
    throw new Error(
      `Bundle ${label}: recipe.json "name" (${JSON.stringify(recipe.name)}) must equal manifest.json "slug" (${JSON.stringify(manifest.slug)})`,
    );
  }

  const declared = manifest.prompts ?? {};
  const strategyIds = Object.keys(declared);

  // Shipping prompt pairs only makes sense for LLM-calling strategies.
  if (strategyIds.length > 0 && !manifest.permissions.includes('llm')) {
    throw new Error(
      `Bundle ${label}: manifest.json declares prompts but "permissions" is missing "llm"`,
    );
  }

  const prompts: Record<string, Record<string, BundlePromptPair>> = {};
  for (const strategyId of strategyIds) {
    prompts[strategyId] = {};
    for (const name of declared[strategyId]) {
      const system = await readPromptFile(label, read, strategyId, name, 'system');
      const user = await readPromptFile(label, read, strategyId, name, 'user');

      // Same invariance rule as config.loader's split templates: system text
      // must stay byte-identical across calls (role separation + caching).
      const systemVars = extractTemplateVars(system);
      if (systemVars.length > 0) {
        throw new Error(
          `Bundle ${label}: prompt "${strategyId}/${name}": system file must not contain {{...}} placeholders ` +
            `(found: ${JSON.stringify(systemVars)}). Move variable content to the user file.`,
        );
      }

      prompts[strategyId][name] = { system, user };
    }
  }

  return { manifest, recipe, prompts };
}

/**
 * Load and fully validate a strategy bundle from a local directory.
 * Thin wrapper over `loadBundleFromFiles` with a filesystem reader.
 * Throws on ANY inconsistency — a returned LoadedBundle is safe to register.
 */
export async function loadBundleFromDir(dir: string): Promise<LoadedBundle> {
  const bundleDir = resolve(dir);
  const validated = await loadBundleFromFiles(bundleDir, (relativePath) =>
    readFile(join(bundleDir, relativePath), 'utf8'),
  );
  return { dir: bundleDir, ...validated };
}

/**
 * Make a loaded bundle's recipe resolvable through the same lookup path the
 * `runRecipe` MCP tool uses (core/recipe/recipe-loader), carrying the bundle's
 * prompt overrides alongside it so a run of that recipe layers them over the
 * shipped prompts (getBundlePrompts + run-scoped override store). Collision
 * with a shipped recipe ref rejects — bundles never shadow shipped recipes.
 * Prompt overrides are validated for overridability first (each must shadow a
 * shipped template prompt) — a bundle failing that check is rejected outright.
 * In-memory only.
 */
export function registerBundle(loaded: LoadedBundle, options: RegisterBundleRecipeOptions): void {
  // The overridability check already prefixes its errors with the bundle label,
  // so it stays outside the wrap below (which contextualizes registerBundleRecipe's
  // bare messages) to avoid a doubled "Bundle <dir>:" prefix.
  assertBundlePromptsOverridable(loaded.prompts, loaded.dir);
  try {
    registerBundleRecipe(loaded.recipe, options, loaded.prompts);
  } catch (err) {
    throw new Error(`Bundle ${loaded.dir}: ${(err as Error).message}`);
  }
}
