import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecipe, resetRecipeCache } from "./recipe-loader.mjs";
import type { Recipe } from "./recipe.schema.mjs";

function validRecipeBody(name: string): Recipe {
  return {
    schemaVersion: "1.0",
    name,
    domain: "wardley",
    tool: "evolution",
    steps: [
      { stepId: "s1", tool: "wardley:evolution:write:capacity:s-curve" },
    ],
    listeners: [],
  };
}

async function writeRecipe(root: string, framework: string, tool: string, name: string, body: Recipe): Promise<void> {
  const dir = join(root, "recipes", framework, tool);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.recipe.json`), JSON.stringify(body), "utf8");
}

describe("recipe-loader (shipped + override)", () => {
  let shippedRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    resetRecipeCache();
    shippedRoot = await mkdtemp(join(tmpdir(), "labre-shipped-"));
    projectRoot = await mkdtemp(join(tmpdir(), "labre-project-"));
  });

  it("loads a shipped recipe when no override exists", async () => {
    const body = validRecipeBody("estimate-component");
    await writeRecipe(shippedRoot, "wardley", "evolution", "estimate-component", body);

    const loaded = await loadRecipe({
      framework: "wardley",
      tool: "evolution",
      name: "estimate-component",
      shippedRoot,
      projectRoot,
    });

    assert.equal(loaded.name, "estimate-component");
    assert.equal(loaded.steps[0].tool, "wardley:evolution:write:capacity:s-curve");
  });

  it("user override takes precedence over shipped", async () => {
    const shipped = validRecipeBody("estimate-component");
    shipped.steps[0].tool = "wardley:evolution:write:capacity:s-curve";

    const overridden = validRecipeBody("estimate-component");
    overridden.steps[0].tool = "wardley:evolution:write:capacity:llm-direct";

    await writeRecipe(shippedRoot, "wardley", "evolution", "estimate-component", shipped);
    await writeRecipe(projectRoot, "wardley", "evolution", "estimate-component", overridden);

    const loaded = await loadRecipe({
      framework: "wardley",
      tool: "evolution",
      name: "estimate-component",
      shippedRoot,
      projectRoot,
    });

    assert.equal(loaded.steps[0].tool, "wardley:evolution:write:capacity:llm-direct");
  });

  it("throws when the recipe does not exist in either location", async () => {
    await assert.rejects(
      loadRecipe({
        framework: "wardley",
        tool: "evolution",
        name: "no-such-recipe",
        shippedRoot,
        projectRoot,
      }),
      /Recipe not found/,
    );
  });

  it("throws on invalid recipe JSON", async () => {
    const dir = join(shippedRoot, "recipes", "wardley", "evolution");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "broken.recipe.json"), "{not valid json", "utf8");

    await assert.rejects(
      loadRecipe({
        framework: "wardley",
        tool: "evolution",
        name: "broken",
        shippedRoot,
        projectRoot,
      }),
      /Invalid JSON/,
    );
  });

  it("throws on schema-invalid recipe content", async () => {
    const dir = join(shippedRoot, "recipes", "wardley", "evolution");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "missing-steps.recipe.json"),
      JSON.stringify({ schemaVersion: "1.0", name: "x", domain: "wardley", tool: "evolution" }),
      "utf8",
    );

    await assert.rejects(
      loadRecipe({
        framework: "wardley",
        tool: "evolution",
        name: "missing-steps",
        shippedRoot,
        projectRoot,
      }),
      /failed validation/,
    );
  });

  it("caches loaded recipes by lookup key", async () => {
    const body = validRecipeBody("cached");
    await writeRecipe(shippedRoot, "wardley", "evolution", "cached", body);

    const first = await loadRecipe({
      framework: "wardley",
      tool: "evolution",
      name: "cached",
      shippedRoot,
      projectRoot,
    });
    // Delete the file on disk — a second load should still succeed from cache.
    await rm(join(shippedRoot, "recipes", "wardley", "evolution", "cached.recipe.json"));
    const second = await loadRecipe({
      framework: "wardley",
      tool: "evolution",
      name: "cached",
      shippedRoot,
      projectRoot,
    });
    assert.equal(first, second);
  });
});
