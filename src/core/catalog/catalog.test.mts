// The kernel's data catalogues (CH-24 / ARCH-28).
//
// NO LLM, NO NETWORK. Everything here is a constant, a directory walk of this
// package's own `schema/` and `recipes/`, or an in-memory registry.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GRAMMAR } from "./grammar.mjs";
import {
  listShippedRecipes,
  listShippedSchemas,
  readShippedSchema,
  resetShippedAssetCache,
} from "./shipped-assets.mjs";
import { SHIPPED_ROOT } from "../shipped-root.mjs";
import { METHOD_ID_5_SEGMENT_REGEX } from "../ast/base-strategy.mjs";
import { StrategyRegistry } from "../registry/strategy-registry.mjs";
import { BaseStrategy, type StrategyResult } from "../ast/base-strategy.mjs";

beforeEach(() => {
  resetShippedAssetCache();
});

class RealStrategy extends BaseStrategy<unknown, string> {
  async evaluate(): Promise<StrategyResult<string>> {
    return { signals: [], reasoning: [], insights: [], result: "real" };
  }
}
class ScaffoldStrategy extends BaseStrategy<unknown, string> {
  async evaluate(): Promise<StrategyResult<string>> {
    return { signals: [], reasoning: [], insights: [], result: "mock" };
  }
}
class RetiredStrategy extends BaseStrategy<unknown, string> {
  static get disabled(): { reason: string } {
    return { reason: "superseded by the recipe fan-out" };
  }
  async evaluate(): Promise<StrategyResult<string>> {
    return { signals: [], reasoning: [], insights: [], result: "never" };
  }
}

describe("grammar catalogue", () => {
  it("declares the five segments in order", () => {
    assert.deepEqual(
      GRAMMAR.segments.map((s) => s.position),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      GRAMMAR.segments.map((s) => s.name),
      ["domain", "tool", "sub-domain", "command", "strategy"],
    );
  });

  it("publishes the SAME regex the registry enforces, not a copy of it", () => {
    // A hand-typed second regex is how a grammar doc starts lying. This one is
    // the imported source of the constant the registry validates against.
    assert.equal(GRAMMAR.regex, METHOD_ID_5_SEGMENT_REGEX.source);
    const rebuilt = new RegExp(GRAMMAR.regex);
    assert.ok(rebuilt.test("wardley:map:value-chain:generate:default"));
    assert.ok(!rebuilt.test("wardley:map:value-chain:generate"));
  });
});

describe("strategy catalogue — implementation provenance", () => {
  it("reports real, mock and disabled, sorted by methodId", () => {
    const registry = new StrategyRegistry();
    registry.register("wardley:map:value-chain:generate:top-down", RealStrategy);
    registry.registerMock("wardley:map:quality:audit:default", ScaffoldStrategy);
    registry.register("wardley:map:output:update:default", RetiredStrategy);

    assert.deepEqual(registry.catalogue(), [
      {
        methodId: "wardley:map:output:update:default",
        implementation: "real",
        disabledReason: "superseded by the recipe fan-out",
      },
      { methodId: "wardley:map:quality:audit:default", implementation: "mock" },
      { methodId: "wardley:map:value-chain:generate:top-down", implementation: "real" },
    ]);
  });

  it("registerMock registers for real — provenance is metadata, not a stub", () => {
    const registry = new StrategyRegistry();
    registry.registerMock("wardley:map:quality:audit:default", ScaffoldStrategy);
    assert.ok(registry.has("wardley:map:quality:audit:default"));
    assert.equal(registry.get("wardley:map:quality:audit:default"), ScaffoldStrategy);
    assert.equal(registry.isMock("wardley:map:quality:audit:default"), true);
    assert.equal(registry.isMock("wardley:map:value-chain:generate:top-down"), false);
  });

  it("refuses a duplicate registration through either verb", () => {
    const registry = new StrategyRegistry();
    registry.registerMock("wardley:map:quality:audit:default", ScaffoldStrategy);
    assert.throws(
      () => registry.register("wardley:map:quality:audit:default", RealStrategy),
      /already registered/,
    );
  });
});

describe("shipped assets — schemas", () => {
  it("lists the published JSON Schemas, sorted, with no other file", async () => {
    const schemas = await listShippedSchemas(SHIPPED_ROOT);
    assert.ok(schemas.length > 0, "expected this package to ship at least one schema");
    const ids = schemas.map((s) => s.id);
    assert.deepEqual([...ids].sort(), ids, "listing must be sorted by id");
    for (const s of schemas) {
      assert.match(s.fileName, /^[a-z0-9-]+\.schema\.json$/);
      assert.equal(s.fileName, `${s.id}.schema.json`);
    }
    // The two the costume is required to publish (ARCH-28).
    assert.ok(ids.includes("wardley-map"));
    assert.ok(ids.includes("json-labre"));
  });

  it("reads a schema as parseable JSON", async () => {
    const text = await readShippedSchema(SHIPPED_ROOT, "wardley-map");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(typeof parsed, "object");
  });

  it("refuses an id that could walk out of schema/", async () => {
    await assert.rejects(
      () => readShippedSchema(SHIPPED_ROOT, "../../package.json#"),
      /Invalid schema id/,
    );
    await assert.rejects(() => readShippedSchema(SHIPPED_ROOT, "Not_A_Schema"), /Invalid schema id/);
  });
});

describe("shipped assets — recipes", () => {
  it("summarises every shipped recipe with a 3-segment ref and its steps", async () => {
    const recipes = await listShippedRecipes(SHIPPED_ROOT);
    assert.ok(recipes.length > 0, "expected this package to ship at least one recipe");
    const refs = recipes.map((r) => r.ref);
    assert.deepEqual([...refs].sort(), refs, "listing must be sorted by ref");
    for (const r of recipes) {
      assert.equal(r.ref, `${r.domain}:${r.tool}:${r.name}`);
      assert.ok(r.steps.length >= 1);
      for (const step of r.steps) {
        assert.match(step, METHOD_ID_5_SEGMENT_REGEX, `step "${step}" of ${r.ref} is not a methodId`);
      }
    }
    assert.ok(refs.includes("wardley:map:evaluate-map"));
  });

  it("carries no recipe body — a catalogue says what exists, runRecipe runs it", async () => {
    const [first] = await listShippedRecipes(SHIPPED_ROOT);
    assert.deepEqual(
      Object.keys(first).sort(),
      ["description", "domain", "name", "ref", "steps", "tool"].filter((k) =>
        k === "description" ? first.description !== undefined : true,
      ),
    );
  });
});
