// Validates daemon boot wiring: the strategy registry is populated with
// every framework strategy before the HTTP server starts accepting requests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Side-effect: registers prompt parsers consumed by some strategies.
import "#lib/prompts/init.mjs";
import { buildStrategyRegistry, withApiKeys } from "./labre-daemon.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import type { RequestContext } from "../context/request-context.mjs";

describe("labre-daemon boot wiring", () => {
  it("buildStrategyRegistry populates the core registry with every framework strategy", () => {
    // CP10: mocks expand the catalogue. Test the real strategies in isolation
    // by setting the disable flag; the full catalogue (real + mocks) is
    // covered in the next test.
    const prevDisable = process.env.LABRE_DISABLE_MOCKS;
    process.env.LABRE_DISABLE_MOCKS = "1";
    const registry = buildStrategyRegistry();
    process.env.LABRE_DISABLE_MOCKS = prevDisable ?? "";
    const ids = registry.list();
    // map climate position-* (9 = 6 functional + 1 solution + 2 anchor)
    // + map node identify (1)
    // + map basemap generate (1)
    // + map value-chain (5 = 1 generate + 1 organized-y-position + 1 select-by-type + 1 prevent-collision + 1 audit)
    // + render wardley-map (3 = owm parse + owm emit + image emit svg)
    // + iteration purpose audit-purpose-quality (1) = 20 total real strategies
    assert.equal(registry.size(), 20);

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
      // map basemap generate (1)
      "wardley:map:basemap:generate:default",
      // map: value-chain generate + Y layout + select-by-type engine (3)
      "wardley:map:value-chain:generate:top-down",
      "wardley:map:value-chain:organized-y-position:default",
      "wardley:map:value-chain:select-by-type:component",
      // render: owm parse/emit + image emit svg (3)
      "render:wardley-map:owm:parse:dsl",
      "render:wardley-map:owm:emit:dsl",
      "render:wardley-map:image:emit:svg",
      // iteration: purpose audit-purpose-quality (1, promoted from mock)
      "wardley:iteration:purpose:audit-purpose-quality:default",
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

  it("buildStrategyRegistry exposes the full v0.1.0 catalogue (real + mocks)", () => {
    const registry = buildStrategyRegistry();
    // 20 real strategies (CP3-CP6 + basemap/Y-layout/svg + value-chain select-by-type
    // engine + iteration purpose audit-purpose-quality)
    // + 65 mock strategies (CP10) = 85 total.
    assert.equal(registry.size(), 85);
    // Every registered id is a valid 5-segment methodId.
    for (const id of registry.list()) {
      const segments = id.split(":");
      assert.equal(segments.length, 5, `methodId ${id} not 5-segment`);
    }
  });
});

describe("withApiKeys — lab_ keys ride alongside any JWT mode", () => {
  const marker: AuthMiddleware = {
    async authenticate(_headers, context) {
      return { ...context, auth: { userId: "jwt-marker" } };
    },
  };
  const baseCtx: RequestContext = {
    projectId: "t",
    projectRoot: "/t",
    sessionId: "s",
    domain: "wardley",
  };

  function withEnv(url: string | undefined, key: string | undefined, fn: () => void): void {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_ANON_KEY;
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = key;
    try {
      fn();
    } finally {
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = prevKey;
    }
  }

  it("returns the JWT middleware unchanged when SUPABASE_ANON_KEY is absent", () => {
    withEnv("https://test.supabase.co", undefined, () => {
      assert.equal(withApiKeys(marker), marker);
    });
  });

  it("returns the JWT middleware unchanged when SUPABASE_URL is absent", () => {
    withEnv(undefined, "anon", () => {
      assert.equal(withApiKeys(marker), marker);
    });
  });

  it("wraps the JWT middleware when both are set, and non-lab_ bearers still reach it", async () => {
    await new Promise<void>((resolve, reject) => {
      withEnv("https://test.supabase.co", "anon", () => {
        const wrapped = withApiKeys(marker);
        assert.notEqual(wrapped, marker); // a different (routing) middleware
        // A JWT-shaped bearer is routed to the wrapped middleware (the marker),
        // never to the lab_ path — so no network call happens here.
        wrapped
          .authenticate({ authorization: "Bearer eyJ.jwt.sig" }, baseCtx)
          .then((ctx) => {
            assert.equal(ctx.auth?.userId, "jwt-marker");
            resolve();
          })
          .catch(reject);
      });
    });
  });
});
