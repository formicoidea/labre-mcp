import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAuthDoors } from "./auth-modes.mjs";

describe("parseAuthDoors", () => {
  it("empty/undefined/none → no doors", () => {
    assert.equal(parseAuthDoors(undefined).size, 0);
    assert.equal(parseAuthDoors("").size, 0);
    assert.equal(parseAuthDoors("none").size, 0);
  });

  it("parses a list, order-independent and whitespace-tolerant, deduped", () => {
    assert.deepEqual(
      [...parseAuthDoors(" oidc , supabase ,supabase, api-key ")].sort(),
      ["api-key", "oidc", "supabase"],
    );
  });

  it("a stray none token is ignored among real doors", () => {
    assert.deepEqual([...parseAuthDoors("supabase,none")], ["supabase"]);
  });

  it("an unknown entry throws (fail-closed), naming the valid ones", () => {
    assert.throws(() => parseAuthDoors("supabase,both"), /both.*supabase, oidc, api-key/s);
  });
});
