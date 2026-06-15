// Validates that every shipped recipe (under <repo>/recipes/):
//   1. parses against the canonical Zod schema (RecipeSchema), and
//   2. references only methodIds that the daemon's StrategyRegistry actually
//      resolves at boot.
//
// (1) catches schema drift. (2) catches aspirational recipes — every
// step.tool and every listener must be a class registered via the framework
// register*Strategies() functions, otherwise the recipe would crash at
// runtime on the first invocation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "#lib/prompts/init.mjs";
import { RecipeSchema } from "./recipe.schema.mjs";
import { buildStrategyRegistry } from "#core/transport/labre-daemon.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const recipesRoot = join(repoRoot, "recipes");

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

describe("shipped recipes validate against RecipeSchema", () => {
  it("every *.recipe.json under <repo>/recipes/ parses successfully", async () => {
    let count = 0;
    for await (const path of walkRecipeFiles(recipesRoot)) {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      const result = RecipeSchema.safeParse(parsed);
      if (!result.success) {
        const details = result.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n");
        assert.fail(`Recipe ${path} failed validation:\n${details}`);
      }
      count += 1;
    }
    assert.ok(count > 0, `Expected at least one shipped recipe under ${recipesRoot}, found ${count}`);
  });

  it("every step.tool and listener resolves against the daemon registry", async () => {
    const registry = buildStrategyRegistry();
    const knownIds = new Set(registry.list());
    const unresolved: Array<{ recipe: string; field: string; tool: string }> = [];

    for await (const path of walkRecipeFiles(recipesRoot)) {
      const raw = await readFile(path, "utf8");
      const parsed = RecipeSchema.parse(JSON.parse(raw));
      for (const [i, step] of parsed.steps.entries()) {
        if (!knownIds.has(step.tool)) {
          unresolved.push({ recipe: path, field: `steps[${i}].tool`, tool: step.tool });
        }
      }
      for (const [stepId, ids] of Object.entries(parsed.listeners)) {
        for (const [k, listener] of ids.entries()) {
          if (!knownIds.has(listener)) {
            unresolved.push({ recipe: path, field: `listeners.${stepId}[${k}]`, tool: listener });
          }
        }
      }
    }

    if (unresolved.length > 0) {
      const details = unresolved
        .map((u) => `  ${u.recipe} :: ${u.field} = "${u.tool}"`)
        .join("\n");
      assert.fail(
        `Found ${unresolved.length} recipe step(s) referencing unknown methodIds:\n${details}\n` +
          `Registry knows (${knownIds.size}): ${[...knownIds].sort().join(", ")}`,
      );
    }
  });
});
