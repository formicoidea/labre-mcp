// Local loader for strategy bundles (v0).
//
// A bundle is a DATA-ONLY directory (manifest.json + recipe.json + optional
// prompts/<strategyId>/<name>.{system,user}.md split pairs) layered on top of
// the shipped primitives — see src/schemas/strategy-bundle.schema.mts for the
// layout contract. This loader validates HARD and throws descriptive Errors
// naming the bundle dir and the offending file/field; degradation policy is
// the caller's concern (later phases fetch bundles from Supabase and decide
// what a failed bundle means for boot).
//
// Static checks performed at load time:
//   - manifest.json matches StrategyBundleManifestSchema;
//   - recipe.json matches the shipped RecipeSchema (which already enforces the
//     5-segment methodId grammar on every step `tool` via methodIdSchema);
//   - recipe.name === manifest.slug (one recipe per bundle, addressed by slug);
//   - declared prompt pairs imply the "llm" permission;
//   - every declared pair exists on disk, is CRLF→LF normalized, and its
//     system file is invariant (no {{...}} placeholders — same rule as
//     lib/prompts/config.loader).

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateOrThrow } from '#lib/zod/validate-or-throw.mjs';
import { extractTemplateVars } from '#lib/prompts/config.loader.mjs';
import {
  StrategyBundleManifestSchema,
  type StrategyBundleManifest,
} from '#schemas/strategy-bundle.schema.mjs';
import { RecipeSchema, type Recipe } from '#core/recipe/recipe.schema.mjs';
import {
  registerBundleRecipe,
  type RegisterBundleRecipeOptions,
} from '#core/recipe/recipe-loader.mjs';

/** One split prompt pair, CRLF-normalized. */
export interface BundlePromptPair {
  /** Invariant system message — guaranteed free of {{...}} placeholders. */
  system: string;
  /** User message template — {{var}} placeholders allowed. */
  user: string;
}

export interface LoadedBundle {
  /** Absolute directory the bundle was loaded from (error context for callers). */
  dir: string;
  manifest: StrategyBundleManifest;
  recipe: Recipe;
  /** strategyId → promptName → pair contents (empty record when none declared). */
  prompts: Record<string, Record<string, BundlePromptPair>>;
}

async function readJsonFile(bundleDir: string, fileName: string): Promise<unknown> {
  const path = join(bundleDir, fileName);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`Bundle ${bundleDir}: cannot read ${fileName}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Bundle ${bundleDir}: invalid JSON in ${fileName}: ${(err as Error).message}`);
  }
}

async function readPromptFile(
  bundleDir: string,
  strategyId: string,
  name: string,
  role: 'system' | 'user',
): Promise<string> {
  const relative = join('prompts', strategyId, `${name}.${role}.md`);
  let raw: string;
  try {
    raw = await readFile(join(bundleDir, relative), 'utf8');
  } catch (err) {
    throw new Error(
      `Bundle ${bundleDir}: prompt "${strategyId}/${name}": cannot read ${role} file ${relative}: ${(err as Error).message}`,
    );
  }
  // CRLF → LF, same Windows-parity normalization as lib/prompts/config.loader.
  return raw.replace(/\r\n/g, '\n');
}

/**
 * Load and fully validate a strategy bundle from a local directory.
 * Throws on ANY inconsistency — a returned LoadedBundle is safe to register.
 */
export async function loadBundleFromDir(dir: string): Promise<LoadedBundle> {
  const bundleDir = resolve(dir);

  const manifest = validateOrThrow(
    StrategyBundleManifestSchema,
    await readJsonFile(bundleDir, 'manifest.json'),
    `Bundle ${bundleDir}: manifest.json`,
  );
  // RecipeSchema enforces the 5-segment methodId grammar on every step.tool.
  const recipe = validateOrThrow(
    RecipeSchema,
    await readJsonFile(bundleDir, 'recipe.json'),
    `Bundle ${bundleDir}: recipe.json`,
  );

  // The bundle's single recipe is addressed by the manifest slug.
  if (recipe.name !== manifest.slug) {
    throw new Error(
      `Bundle ${bundleDir}: recipe.json "name" (${JSON.stringify(recipe.name)}) must equal manifest.json "slug" (${JSON.stringify(manifest.slug)})`,
    );
  }

  const declared = manifest.prompts ?? {};
  const strategyIds = Object.keys(declared);

  // Shipping prompt pairs only makes sense for LLM-calling strategies.
  if (strategyIds.length > 0 && !manifest.permissions.includes('llm')) {
    throw new Error(
      `Bundle ${bundleDir}: manifest.json declares prompts but "permissions" is missing "llm"`,
    );
  }

  const prompts: Record<string, Record<string, BundlePromptPair>> = {};
  for (const strategyId of strategyIds) {
    prompts[strategyId] = {};
    for (const name of declared[strategyId]) {
      const system = await readPromptFile(bundleDir, strategyId, name, 'system');
      const user = await readPromptFile(bundleDir, strategyId, name, 'user');

      // Same invariance rule as config.loader's split templates: system text
      // must stay byte-identical across calls (role separation + caching).
      const systemVars = extractTemplateVars(system);
      if (systemVars.length > 0) {
        throw new Error(
          `Bundle ${bundleDir}: prompt "${strategyId}/${name}": system file must not contain {{...}} placeholders ` +
            `(found: ${JSON.stringify(systemVars)}). Move variable content to the user file.`,
        );
      }

      prompts[strategyId][name] = { system, user };
    }
  }

  return { dir: bundleDir, manifest, recipe, prompts };
}

/**
 * Make a loaded bundle's recipe resolvable through the same lookup path the
 * `runRecipe` MCP tool uses (core/recipe/recipe-loader). Collision with a
 * shipped recipe ref rejects — bundles never shadow shipped recipes.
 * In-memory only; wiring into boot is a later phase.
 */
export function registerBundle(loaded: LoadedBundle, options: RegisterBundleRecipeOptions): void {
  try {
    registerBundleRecipe(loaded.recipe, options);
  } catch (err) {
    throw new Error(`Bundle ${loaded.dir}: ${(err as Error).message}`);
  }
}
