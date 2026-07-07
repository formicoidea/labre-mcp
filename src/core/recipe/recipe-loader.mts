// Recipe loader implementing the shipped + user-override pattern (ARCH-08).
//
// Lookup order for recipe name "evaluate-map" in framework "wardley", tool "evolution":
//   1. <projectRoot>/recipes/wardley/evolution/evaluate-map.recipe.json (user)
//   2. in-memory bundle recipes (registerBundleRecipe — never shadows shipped)
//   3. <shippedRoot>/recipes/wardley/evolution/evaluate-map.recipe.json (built-in)
//
// User recipe takes precedence by name (no field-level merge — recipes are
// integral declarations). Loader caches per (framework, tool, name).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateOrThrow } from "#lib/zod/validate-or-throw.mjs";
import { RecipeSchema, type Recipe } from "./recipe.schema.mjs";

export interface RecipeLookupOptions {
  framework: string;
  tool: string;
  name: string;
  projectRoot?: string; // optional override location for user recipes
  shippedRoot: string;  // labre-mcp's own install root (where shipped recipes live)
}

const cache = new Map<string, Recipe>();

function cacheKey(o: RecipeLookupOptions): string {
  return `${o.projectRoot ?? "_"}::${o.shippedRoot}::${o.framework}:${o.tool}:${o.name}`;
}

function recipePath(root: string, framework: string, tool: string, name: string): string {
  return join(resolve(root), "recipes", framework, tool, `${name}.recipe.json`);
}

// In-memory registry of bundle-provided recipes, keyed "<domain>:<tool>:<name>".
// Registered recipes join the same lookup path loadRecipe serves (so runRecipe
// resolves them by ref), ranked BELOW user overrides and beside shipped ones —
// a bundle may never shadow a shipped recipe (collision rejected at
// registration). Populated by lib/bundles/bundle-loader `registerBundle`.
const bundleRecipes = new Map<string, Recipe>();

export interface RegisterBundleRecipeOptions {
  /** labre-mcp's own install root — used only for the shipped-collision check. */
  shippedRoot: string;
}

/** Make an already-validated bundle recipe resolvable by loadRecipe. */
export function registerBundleRecipe(recipe: Recipe, options: RegisterBundleRecipeOptions): void {
  const ref = `${recipe.domain}:${recipe.tool}:${recipe.name}`;
  const shippedPath = recipePath(options.shippedRoot, recipe.domain, recipe.tool, recipe.name);
  if (existsSync(shippedPath)) {
    throw new Error(
      `Cannot register bundle recipe "${ref}": it collides with the shipped recipe at ${shippedPath}`,
    );
  }
  if (bundleRecipes.has(ref)) {
    throw new Error(`Cannot register bundle recipe "${ref}": a bundle recipe with this ref is already registered`);
  }
  bundleRecipes.set(ref, recipe);
}

/**
 * Forget all registered bundle recipes. Used by tests AND by the Supabase
 * bundle source's refresh swap: a validated refresh calls this then
 * re-registers the new set synchronously (no await in between), so lookups
 * never observe a half-swapped registry.
 */
export function resetBundleRecipes(): void {
  bundleRecipes.clear();
}

async function tryReadRecipe(path: string): Promise<Recipe | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in recipe ${path}: ${(err as Error).message}`);
  }
  return validateOrThrow(RecipeSchema, parsed, `Recipe ${path}`);
}

export async function loadRecipe(options: RecipeLookupOptions): Promise<Recipe> {
  // Tests routinely write override recipes into temp dirs and re-load them;
  // a memoized cache between tests would mask drift. Auto-clear under NODE_ENV=test.
  if (process.env.NODE_ENV === "test") {
    cache.clear();
  }
  const key = cacheKey(options);
  const hit = cache.get(key);
  if (hit) return hit;

  // 1. User override at projectRoot if provided
  if (options.projectRoot) {
    const userPath = recipePath(options.projectRoot, options.framework, options.tool, options.name);
    const userRecipe = await tryReadRecipe(userPath);
    if (userRecipe) {
      cache.set(key, userRecipe);
      return userRecipe;
    }
  }

  // 2. Registered bundle recipe (guaranteed not to collide with shipped —
  //    registration rejects shadowing, so ordering vs. step 3 is inert).
  const bundleHit = bundleRecipes.get(`${options.framework}:${options.tool}:${options.name}`);
  if (bundleHit) return bundleHit;

  // 3. Shipped recipe
  const shippedPath = recipePath(options.shippedRoot, options.framework, options.tool, options.name);
  const shipped = await tryReadRecipe(shippedPath);
  if (!shipped) {
    throw new Error(
      `Recipe not found: ${options.framework}:${options.tool}:${options.name} (looked in ${shippedPath}${options.projectRoot ? ` and ${recipePath(options.projectRoot, options.framework, options.tool, options.name)}` : ""})`,
    );
  }
  cache.set(key, shipped);
  return shipped;
}

/** Test-only: clear the memoized cache so the next call re-reads. */
export function resetRecipeCache(): void {
  cache.clear();
}
