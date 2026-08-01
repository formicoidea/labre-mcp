// Regression guard (transport migration, 2026-07): the side-effect import that
// registers every custom prompt parser (#lib/prompts/init.mjs) lived in the
// removed stdio entrypoint and was lost, so in production NO parser was
// registered and every parser-backed recipe/strategy threw "parser 'X' is not
// registered". buildBootRegistry (the shared boot path for HTTP + stdio) must
// pull it in.
//
// This file deliberately does NOT import "#lib/prompts/init.mjs" — importing it
// here would register the parsers regardless of the boot path and mask the very
// bug this test guards. node:test runs each file in its own process, so the
// only way a parser is registered here is through buildBootRegistry itself.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBootRegistry } from "./boot-tool-registry.mjs";
import { hasParser } from "#lib/prompts/parsers-registry.mjs";

describe("boot registers custom prompt parsers", () => {
  it("registers parsers through the shared boot path (not only in tests)", () => {
    buildBootRegistry();
    for (const id of [
      "extractChainMetadata", // write-chain — the one that surfaced the bug
      "parseRawValueChain",
      "identifyCapability",
      "cpcSotExtraction",
    ]) {
      assert.ok(hasParser(id), `parser "${id}" must be registered at boot`);
    }
  });
});
