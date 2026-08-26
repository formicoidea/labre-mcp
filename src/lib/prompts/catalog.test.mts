// The prompt catalogue (CH-24 / ARCH-28) — enumeration over the registry the
// rest of the code base only ever indexed. No LLM, no network: this reads the
// same memoised prompts.config.json the loader already validated.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPromptCatalogEntry, listPromptCatalog } from "./catalog.mjs";
import { getPrompt } from "./registry.mjs";

describe("prompt catalogue", () => {
  it("lists every declared prompt, sorted by id", () => {
    const entries = listPromptCatalog();
    assert.ok(entries.length > 0);
    const ids = entries.map((e) => e.id);
    assert.deepEqual([...ids].sort(), ids);
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
    for (const e of entries) {
      assert.equal(e.id, `${e.strategy}/${e.name}`);
    }
  });

  it("reports the declared variables and the split-pair shape", () => {
    const entry = getPromptCatalogEntry("identify-capability/default");
    assert.ok(entry);
    assert.equal(entry.kind, "template");
    assert.equal(entry.hasSystemHalf, true);
    assert.deepEqual([...entry.variables].sort(), ["component", "context", "description"]);
  });

  it("agrees with the registry it enumerates", () => {
    // The catalogue must describe prompts that actually resolve — an entry the
    // registry cannot build would be a listing of fiction.
    for (const entry of listPromptCatalog()) {
      if (entry.kind !== "template") continue;
      const resolved = getPrompt(entry.strategy, entry.name);
      const vars = Object.fromEntries(entry.variables.map((v) => [v, `<${v}>`]));
      const built = resolved.build(vars);
      assert.equal(typeof built.user, "string");
      assert.equal(
        built.system !== undefined,
        entry.hasSystemHalf,
        `${entry.id}: hasSystemHalf disagrees with what build() returns`,
      );
    }
  });

  it("returns undefined for an unknown id", () => {
    assert.equal(getPromptCatalogEntry("no-such-strategy/default"), undefined);
  });
});
