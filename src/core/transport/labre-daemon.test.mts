// Validates daemon boot wiring: the strategy registry is populated with
// every framework strategy before the HTTP server starts accepting requests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Side-effect: registers prompt parsers consumed by some strategies.
import "#lib/prompts/init.mjs";
import {
  buildStrategyRegistry,
  isSupabaseIssuedToken,
  selectAuthMiddleware,
} from "./labre-daemon.mjs";

const SUPABASE_ISSUER = "https://proj.supabase.co/auth/v1";

/** Unsigned JWT shell — `decodeJwt` never checks the signature. */
function jwtWithIssuer(iss: string): string {
  const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss })}.not-a-real-signature`;
}

describe("isSupabaseIssuedToken — bundle refresh routing", () => {
  it("accepts a Supabase session token", () => {
    assert.equal(isSupabaseIssuedToken(jwtWithIssuer(SUPABASE_ISSUER), SUPABASE_ISSUER), true);
  });

  it("rejects an OAuth-AS token — PostgREST cannot verify its signature", () => {
    // The regression this guards: forwarding it made every OAuth-connector
    // call log `listing failed … No suitable key or wrong key type`.
    const asToken = jwtWithIssuer("https://proj.supabase.co/functions/v1/oauth-as");
    assert.equal(isSupabaseIssuedToken(asToken, SUPABASE_ISSUER), false);
  });

  it("rejects a bearer that is not a decodable JWT", () => {
    assert.equal(isSupabaseIssuedToken("lab_deadbeef", SUPABASE_ISSUER), false);
  });
});

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
    // + render wardley-map (6 = owm parse/emit + image emit/parse svg + image emit/parse png)
    // + iteration purpose (2 = generate + audit-purpose-quality)
    // + render text lint (1) = 25 total real strategies
    assert.equal(registry.size(), 25);

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
      // render: owm parse/emit + image emit/parse svg + image emit/parse png (6)
      "render:wardley-map:owm:parse:dsl",
      "render:wardley-map:owm:emit:dsl",
      "render:wardley-map:image:emit:svg",
      "render:wardley-map:image:parse:svg",
      "render:wardley-map:image:emit:png",
      "render:wardley-map:image:parse:png",
      // render: LLM linter for near-structured value-chain text (1)
      "render:wardley-map:text:lint:default",
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
    // 25 real strategies (CP3-CP6 + basemap/Y-layout + render image emit/parse svg+png + text lint +
    // value-chain select-by-type engine + iteration purpose generate + audit-purpose-quality)
    // + 61 mock strategies (CP10, image emit/parse png promoted) = 86 total
    // (text:lint:default is NEW surface, not a promoted mock).
    assert.equal(registry.size(), 86);
    // Every registered id is a valid 5-segment methodId.
    for (const id of registry.list()) {
      const segments = id.split(":");
      assert.equal(segments.length, 5, `methodId ${id} not 5-segment`);
    }
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

  const LIST_FULL = {
    LABRE_AUTH: "supabase,oidc,api-key",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    AUTH_JWKS_URL: "https://idp.example/.well-known/jwks.json",
    AUTH_AUDIENCE: "api://labre-mcp",
  } as const;

  it("the full list supabase,oidc,api-key boots (returns a middleware)", () => {
    withAuthEnv(LIST_FULL, () => {
      assert.notEqual(selectAuthMiddleware(), undefined);
    });
  });

  // supabase+oidc together: each JWT door validates its own env, fail-fast on
  // the first unsatisfied door, naming that door and its missing var.
  it("supabase,oidc without SUPABASE_URL refuses to boot, naming the supabase door", () => {
    withAuthEnv(
      { LABRE_AUTH: "supabase,oidc", AUTH_JWKS_URL: "https://idp.example/keys", AUTH_AUDIENCE: "aud" },
      () => {
        assert.throws(
          () => selectAuthMiddleware(),
          (err: Error) => err.message.includes('"supabase"') && err.message.includes("SUPABASE_URL"),
        );
      },
    );
  });

  for (const missing of ["AUTH_JWKS_URL", "AUTH_AUDIENCE"] as const) {
    it(`supabase,oidc without ${missing} refuses to boot, naming the oidc door`, () => {
      const env: Record<string, string> = {
        LABRE_AUTH: "supabase,oidc",
        SUPABASE_URL: "https://test.supabase.co",
        AUTH_JWKS_URL: "https://idp.example/.well-known/jwks.json",
        AUTH_AUDIENCE: "api://labre-mcp",
      };
      delete env[missing];
      withAuthEnv(env, () => {
        assert.throws(
          () => selectAuthMiddleware(),
          (err: Error) => err.message.includes('"oidc"') && err.message.includes(missing),
        );
      });
    });
  }

  // Backward compatibility: a single-element list IS the old single mode, with
  // identical fail-closed boot semantics (AC4).
  it("supabase alone still requires SUPABASE_URL and boots with it", () => {
    withAuthEnv({ LABRE_AUTH: "supabase" }, () => {
      assert.throws(() => selectAuthMiddleware(), /SUPABASE_URL/);
    });
    withAuthEnv({ LABRE_AUTH: "supabase", SUPABASE_URL: "https://test.supabase.co" }, () => {
      assert.notEqual(selectAuthMiddleware(), undefined);
    });
  });

  it("oidc alone still requires AUTH_JWKS_URL + AUTH_AUDIENCE and boots with them", () => {
    withAuthEnv({ LABRE_AUTH: "oidc", AUTH_JWKS_URL: "https://idp.example/keys" }, () => {
      assert.throws(() => selectAuthMiddleware(), /AUTH_AUDIENCE/);
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

  // api-key is now an EXPLICIT door (no implicit rider). It stands alone and
  // fails closed on its own env.
  it("api-key alone boots with SUPABASE_URL + SUPABASE_ANON_KEY", () => {
    withAuthEnv(
      { LABRE_AUTH: "api-key", SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "anon" },
      () => {
        assert.notEqual(selectAuthMiddleware(), undefined);
      },
    );
  });

  it("api-key without SUPABASE_ANON_KEY refuses to boot, naming the api-key door", () => {
    withAuthEnv({ LABRE_AUTH: "api-key", SUPABASE_URL: "https://test.supabase.co" }, () => {
      assert.throws(
        () => selectAuthMiddleware(),
        (err: Error) => err.message.includes('"api-key"') && err.message.includes("SUPABASE_ANON_KEY"),
      );
    });
  });

  // "No static secrets" posture: JWT doors only, api-key deliberately omitted —
  // boots with no anon key at all.
  it("supabase,oidc (no api-key) boots without any anon key", () => {
    withAuthEnv(
      {
        LABRE_AUTH: "supabase,oidc",
        SUPABASE_URL: "https://test.supabase.co",
        AUTH_JWKS_URL: "https://idp.example/.well-known/jwks.json",
        AUTH_AUDIENCE: "api://labre-mcp",
      },
      () => {
        assert.notEqual(selectAuthMiddleware(), undefined);
      },
    );
  });

  it("none/unset/empty stays a noop (undefined middleware)", () => {
    withAuthEnv({}, () => assert.equal(selectAuthMiddleware(), undefined));
    withAuthEnv({ LABRE_AUTH: "none" }, () => assert.equal(selectAuthMiddleware(), undefined));
    withAuthEnv({ LABRE_AUTH: "" }, () => assert.equal(selectAuthMiddleware(), undefined));
  });

  it("an unknown door refuses to boot, naming the valid ones", () => {
    withAuthEnv({ LABRE_AUTH: "both" }, () => {
      assert.throws(() => selectAuthMiddleware(), /supabase, oidc, api-key/);
    });
  });

  // Wiring probes (no network): each topology is identified by the distinct
  // fail-closed error of the middleware that actually answers.
  const PROBE_CTX = { projectId: "t", projectRoot: "/t", sessionId: "s", domain: "wardley" };

  it("full list wires the multi-issuer JWT layer (non-lab_ bearer reaches iss routing)", async () => {
    const auth = withAuthEnv(LIST_FULL, () => selectAuthMiddleware());
    assert.ok(auth);
    // Not lab_-prefixed and not a decodable JWT → must land in the
    // multi-issuer router, whose error names its routing stage.
    await assert.rejects(
      auth.authenticate({ authorization: "Bearer not-a-jwt" }, PROBE_CTX),
      /multi-issuer routing/,
    );
  });

  it("api-key alone wires the standalone api-key middleware (JWT-shaped bearer is refused there)", async () => {
    const auth = withAuthEnv(
      { LABRE_AUTH: "api-key", SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "anon" },
      () => selectAuthMiddleware(),
    );
    assert.ok(auth);
    // No JWT layer exists: a JWT-shaped bearer gets the api-key middleware's
    // own refusal (fail-closed, no network — the RPC is never reached).
    await assert.rejects(
      auth.authenticate({ authorization: "Bearer eyJ.jwt.sig" }, PROBE_CTX),
      /not an API key/,
    );
  });
});
