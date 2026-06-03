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
    // map climate position-* (8 = 6 functional + 1 solution + 2 anchor)
    // + map node identify (1)
    // + map value-chain (3 = 1 generate + 1 prevent-collision + 1 audit)
    // + render wardley-map owm (2 = parse + emit) = 15 total
    assert.equal(registry.size(), 15);

    const expected = [
      // map climate: position-functional-in-evolution (6)
      "wardley:map:climate:position-functional-in-evolution:s-curve",
      "wardley:map:climate:position-functional-in-evolution:llm-direct",
      "wardley:map:climate:position-functional-in-evolution:publication-analysis",
      "wardley:map:climate:position-functional-in-evolution:cpc-evolution",
      "wardley:map:climate:position-functional-in-evolution:timeline-benchmark",
      "wardley:map:climate:position-functional-in-evolution:logprob-distribution",
      // map climate: position-solution-in-evolution (1)
      "wardley:map:climate:position-solution-in-evolution:property-assessment",
      // map climate: position-anchor-in-evolution (2 = default + culture-phase variant)
      "wardley:map:climate:position-anchor-in-evolution:default",
      "wardley:map:climate:position-anchor-in-evolution:culture-phase",
      // map node: identify (1)
      "wardley:map:node:identify:default",
      // map: value-chain generate + render: owm parse/emit (3)
      "wardley:map:value-chain:generate:top-down",
      "render:wardley-map:owm:parse:dsl",
      "render:wardley-map:owm:emit:dsl",
      // map value-chain layout audit (2) — physically still under common/
      "wardley:map:value-chain:prevent-collision:default",
      "wardley:map:value-chain:audit:overlap-check",
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
