// Validates daemon boot wiring: the strategy registry is populated with
// every framework strategy before the HTTP server starts accepting requests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Side-effect: registers prompt parsers consumed by some strategies.
import "#lib/prompts/init.mjs";
import { buildStrategyRegistry, withApiKeys, selectAuthMiddleware } from "./labre-daemon.mjs";
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
    // + iteration purpose (2 = generate + audit-purpose-quality) = 21 total real strategies
    assert.equal(registry.size(), 21);

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
      // iteration: purpose generate + audit-purpose-quality (2, promoted from mock)
      "wardley:iteration:purpose:generate:default",
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
    // 21 real strategies (CP3-CP6 + basemap/Y-layout/svg + value-chain select-by-type
    // engine + iteration purpose generate + audit-purpose-quality)
    // + 64 mock strategies (CP10) = 85 total.
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

describe("selectAuthMiddleware — boot fail-closed matrix (issue #33)", () => {
  // The auth-related env this function reads. Each test states its OWN complete
  // environment; everything else is scrubbed and restored afterwards.
  const AUTH_ENV_KEYS = [
    "LABRE_AUTH",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_JWT_AUD",
    "AUTH_JWKS_URL",
    "AUTH_AUDIENCE",
    "AUTH_ISSUER",
    "AUTH_ROLE_CLAIM",
  ] as const;

  function withAuthEnv<T>(env: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>, fn: () => T): T {
    const previous = new Map<string, string | undefined>();
    for (const key of AUTH_ENV_KEYS) {
      previous.set(key, process.env[key]);
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const key of AUTH_ENV_KEYS) {
        const prev = previous.get(key);
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      }
    }
  }

  const MULTI_FULL = {
    LABRE_AUTH: "multi",
    SUPABASE_URL: "https://test.supabase.co",
    AUTH_JWKS_URL: "https://idp.example/.well-known/jwks.json",
    AUTH_AUDIENCE: "api://labre-mcp",
  } as const;

  it('multi with the full env boots (returns a middleware)', () => {
    withAuthEnv(MULTI_FULL, () => {
      assert.notEqual(selectAuthMiddleware(), undefined);
    });
  });

  // Each required var missing, alone, refuses the boot and NAMES the gap.
  for (const missing of ["SUPABASE_URL", "AUTH_JWKS_URL", "AUTH_AUDIENCE"] as const) {
    it(`multi without ${missing} refuses to boot (fail-closed)`, () => {
      const env: Record<string, string> = { ...MULTI_FULL };
      delete env[missing];
      withAuthEnv(env, () => {
        assert.throws(
          () => selectAuthMiddleware(),
          (err: Error) =>
            err.message.includes('LABRE_AUTH="multi"') && err.message.includes(missing),
        );
      });
    });
  }

  it("multi with NO issuer env at all refuses to boot and lists every missing var", () => {
    withAuthEnv({ LABRE_AUTH: "multi" }, () => {
      assert.throws(
        () => selectAuthMiddleware(),
        (err: Error) =>
          err.message.includes("SUPABASE_URL") &&
          err.message.includes("AUTH_JWKS_URL") &&
          err.message.includes("AUTH_AUDIENCE"),
      );
    });
  });

  // Backward compatibility: the three pre-existing modes keep their exact
  // boot semantics (AC4 — rétrocompatibilité totale).
  it("supabase mode still requires SUPABASE_URL and boots with it", () => {
    withAuthEnv({ LABRE_AUTH: "supabase" }, () => {
      assert.throws(() => selectAuthMiddleware(), /SUPABASE_URL/);
    });
    withAuthEnv({ LABRE_AUTH: "supabase", SUPABASE_URL: "https://test.supabase.co" }, () => {
      assert.notEqual(selectAuthMiddleware(), undefined);
    });
  });

  it("oidc mode still requires AUTH_JWKS_URL + AUTH_AUDIENCE and boots with them", () => {
    withAuthEnv({ LABRE_AUTH: "oidc", AUTH_JWKS_URL: "https://idp.example/keys" }, () => {
      assert.throws(() => selectAuthMiddleware(), /AUTH_JWKS_URL and AUTH_AUDIENCE/);
    });
    withAuthEnv(
      {
        LABRE_AUTH: "oidc",
        AUTH_JWKS_URL: "https://idp.example/.well-known/jwks.json",
        AUTH_AUDIENCE: "api://labre-mcp",
      },
      () => {
        assert.notEqual(selectAuthMiddleware(), undefined);
      },
    );
  });

  it("none/unset stays a noop (undefined middleware)", () => {
    withAuthEnv({}, () => assert.equal(selectAuthMiddleware(), undefined));
    withAuthEnv({ LABRE_AUTH: "none" }, () => assert.equal(selectAuthMiddleware(), undefined));
  });

  it("an invalid mode still refuses to boot, now naming multi among the valid ones", () => {
    withAuthEnv({ LABRE_AUTH: "both" }, () => {
      assert.throws(() => selectAuthMiddleware(), /"supabase", "oidc", "multi" or "none"/);
    });
  });
});
