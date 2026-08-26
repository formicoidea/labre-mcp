// Enumeration of the DATA this package ships: the published JSON Schemas
// (`schema/*.json`) and the canonical recipes (`recipes/**/*.recipe.json`).
// CH-24 / ARCH-28.
//
// WHY THE KERNEL OWNS THIS. Both sets already existed on disk and both were
// already reachable — the schemas over `GET /schemas/:file`, the recipes
// through `loadRecipe` by exact name. What did not exist was a way to ASK WHAT
// IS THERE: `loadRecipe` answers "give me this one", never "what do you have".
// A harness that cannot enumerate cannot discover, and discovery is the whole
// point of the costume. The listing is a kernel-side data catalogue for the
// same reason the tool registry contract is: the delivery serves it, the
// kernel knows it.
//
// CACHING. Both listings are memoised per root, and a schema's text is
// memoised per file. The shipped tree does not change under a running process
// (it is inside the installed package), so re-walking it on every
// `resources/list` would buy nothing. `resetShippedAssetCache()` exists for
// tests. Reading files at request time is fine here — hard rule #20 forbids
// `process.cwd()` and `process.env`, not disk.

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RecipeSchema, type Recipe } from "../recipe/recipe.schema.mjs";

/** One published JSON Schema. `id` is the filename without `.schema.json`. */
export interface ShippedSchemaEntry {
  id: string;
  fileName: string;
}

/** One shipped recipe, summarised. Never the whole file: a catalogue says what
 *  exists and how to call it — `runRecipe` is what runs it. */
export interface ShippedRecipeEntry {
  /** 3-segment ref accepted by the `runRecipe` tool. */
  ref: string;
  domain: string;
  tool: string;
  name: string;
  description?: string;
  /** The methodIds this recipe orchestrates, in declaration order. */
  steps: string[];
}

const schemaListCache = new Map<string, ShippedSchemaEntry[]>();
const schemaTextCache = new Map<string, string>();
const recipeListCache = new Map<string, ShippedRecipeEntry[]>();

/** Filename shape of a published schema — the same allowlist the HTTP daemon
 *  applies on `GET /schemas/:file`, so the two surfaces cannot disagree. */
const SCHEMA_FILE_RE = /^[a-z0-9-]+\.schema\.json$/;

function schemaDir(shippedRoot: string): string {
  return join(resolve(shippedRoot), "schema");
}

/**
 * Every JSON Schema this package publishes, sorted by id. The criterion is
 * deliberately mechanical — whatever is in `schema/` and matches the daemon's
 * own filename allowlist — so a schema added by `pnpm schemas` appears here
 * with no second edit.
 */
export async function listShippedSchemas(shippedRoot: string): Promise<ShippedSchemaEntry[]> {
  const dir = schemaDir(shippedRoot);
  const hit = schemaListCache.get(dir);
  if (hit) return hit;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const entries = names
    .filter((n) => SCHEMA_FILE_RE.test(n))
    .map((fileName) => ({ id: fileName.replace(/\.schema\.json$/, ""), fileName }))
    .sort((a, b) => a.id.localeCompare(b.id));
  schemaListCache.set(dir, entries);
  return entries;
}

/**
 * Raw text of one published schema. `id` must come from `listShippedSchemas`;
 * an id that does not match the allowlist is refused rather than resolved, so
 * no caller-supplied string can walk out of `schema/`.
 */
export async function readShippedSchema(shippedRoot: string, id: string): Promise<string> {
  const fileName = `${id}.schema.json`;
  if (!SCHEMA_FILE_RE.test(fileName)) {
    throw new Error(`Invalid schema id "${id}"`);
  }
  const path = join(schemaDir(shippedRoot), fileName);
  const cached = schemaTextCache.get(path);
  if (cached !== undefined) return cached;
  const text = await readFile(path, "utf8");
  schemaTextCache.set(path, text);
  return text;
}

async function* walkRecipeFiles(dir: string): AsyncIterable<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkRecipeFiles(p);
    else if (e.isFile() && e.name.endsWith(".recipe.json")) yield p;
  }
}

function summarise(recipe: Recipe): ShippedRecipeEntry {
  const entry: ShippedRecipeEntry = {
    ref: `${recipe.domain}:${recipe.tool}:${recipe.name}`,
    domain: recipe.domain,
    tool: recipe.tool,
    name: recipe.name,
    steps: recipe.steps.map((s) => s.tool),
  };
  if (recipe.description !== undefined) entry.description = recipe.description;
  return entry;
}

/**
 * Every canonical recipe this package ships, sorted by ref. USER overrides and
 * bundle recipes are deliberately absent: this catalogue describes what the
 * PACKAGE guarantees, and a per-project override is neither stable nor the
 * daemon's to advertise. A caller still invokes an override by the same ref —
 * `loadRecipe` resolves it — it simply is not published here.
 */
export async function listShippedRecipes(shippedRoot: string): Promise<ShippedRecipeEntry[]> {
  const root = join(resolve(shippedRoot), "recipes");
  const hit = recipeListCache.get(root);
  if (hit) return hit;

  const entries: ShippedRecipeEntry[] = [];
  for await (const path of walkRecipeFiles(root)) {
    const raw = await readFile(path, "utf8");
    const parsed = RecipeSchema.safeParse(JSON.parse(raw));
    // A shipped recipe that no longer parses is a bug the dedicated suite
    // (shipped-recipes-validation.test.mts) fails on. The catalogue's job is
    // not to re-litigate it: skip the unreadable entry rather than take down
    // `resources/read` for every caller.
    if (parsed.success) entries.push(summarise(parsed.data));
  }
  entries.sort((a, b) => a.ref.localeCompare(b.ref));
  recipeListCache.set(root, entries);
  return entries;
}

/** Test-only: forget the memoised listings and schema texts. */
export function resetShippedAssetCache(): void {
  schemaListCache.clear();
  schemaTextCache.clear();
  recipeListCache.clear();
}
