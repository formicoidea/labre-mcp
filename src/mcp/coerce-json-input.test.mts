import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coerceJsonInput } from "./coerce-json-input.mjs";

describe("coerceJsonInput", () => {
  it("parses a stringified JSON object (the MCP client bug)", () => {
    const raw = '{"title":"Épargne salariale","context":"PME"}';
    assert.deepEqual(coerceJsonInput(raw), { title: "Épargne salariale", context: "PME" });
  });

  it("parses a stringified JSON array", () => {
    assert.deepEqual(coerceJsonInput("[1,2,3]"), [1, 2, 3]);
  });

  it("tolerates leading/trailing whitespace", () => {
    assert.deepEqual(coerceJsonInput('  {"a":1}\n'), { a: 1 });
  });

  it("leaves an already-structured object untouched", () => {
    const obj = { components: [] };
    assert.equal(coerceJsonInput(obj), obj); // same reference, no copy
  });

  it("leaves a plain natural-language string untouched", () => {
    assert.equal(coerceJsonInput("draw a value chain for savings"), "draw a value chain for savings");
  });

  it("keeps a malformed JSON-ish string as-is (no throw)", () => {
    assert.equal(coerceJsonInput("{not valid json"), "{not valid json");
  });

  it("passes through null and undefined", () => {
    assert.equal(coerceJsonInput(null), null);
    assert.equal(coerceJsonInput(undefined), undefined);
  });
});
