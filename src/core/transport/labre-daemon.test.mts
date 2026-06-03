// Validates daemon boot wiring: the strategy registry is populated with
// every framework strategy before the HTTP server starts accepting requests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Side-effect: registers prompt parsers consumed by some strategies.
import "#lib/prompts/init.mjs";
import { buildStrategyRegistry } from "./labre-daemon.mjs";

describe("labre-daemon boot wiring", () => {
  it("buildStrategyRegistry populates the core registry with every framework strategy", () => {
    const registry = buildStrategyRegistry();
    const ids = registry.list();
    // 9 evolution + 3 chain + 2 common = 14 total
    assert.equal(registry.size(), 14);

    const expected = [
      // evolution capacity (6)
      "wardley:evolution:write:capacity:s-curve",
      "wardley:evolution:write:capacity:llm-direct",
      "wardley:evolution:write:capacity:publication-analysis",
      "wardley:evolution:write:capacity:cpc-evolution",
      "wardley:evolution:write:capacity:timeline-benchmark",
      "wardley:evolution:write:capacity:logprob-distribution",
      // evolution solution (1)
      "wardley:evolution:write:solution:properties",
      // evolution read (1)
      "wardley:evolution:read:component:identify-capability",
      // evolution anchor (1)
      "wardley:evolution:write:anchor:culture-phase",
      // map: value-chain generate + render: owm parse/emit (3)
      "wardley:map:value-chain:generate:top-down",
      "render:wardley-map:owm:parse:dsl",
      "render:wardley-map:owm:emit:dsl",
      // common layout (2)
      "common:layout:write:labels:default",
      "common:layout:quality:overlaps:default",
    ];

    for (const id of expected) {
      assert.equal(registry.has(id), true, `missing methodId: ${id}`);
    }

    // Every id is 5-segment lowercase, no surprises
    for (const id of ids) {
      const segments = id.split(":");
      assert.equal(segments.length, 5, `methodId ${id} not 5-segment`);
    }
  });

  it("buildStrategyRegistry is idempotent across calls (fresh registry each time)", () => {
    const a = buildStrategyRegistry();
    const b = buildStrategyRegistry();
    assert.equal(a.size(), b.size());
    assert.deepEqual(a.list(), b.list());
    // But they are independent instances
    assert.notEqual(a, b);
  });
});
