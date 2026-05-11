// Recipe loader implementing the shipped + user-override pattern (ARCH-08).
//
// Lookup order for recipe name "evaluate-map" in framework "wardley", tool "evolution":
//   1. <projectRoot>/recipes/wardley/evolution/evaluate-map.recipe.json (user)
//   2. <shippedRoot>/recipes/wardley/evolution/evaluate-map.recipe.json (built-in)
//
// User recipe takes precedence by name (no field-level merge — recipes are
// integral declarations). Loader caches per (framework, tool, name).

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  const result = RecipeSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Recipe ${path} failed validation:\n${details}`);
  }
  return result.data;
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

  // 2. Shipped recipe
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
