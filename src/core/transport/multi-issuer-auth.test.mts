// Multi-issuer JWT routing (issue #33): iss-based selection between the
// Supabase and OIDC issuer configs, fail-closed on unknown/missing iss, no
// cross-issuer fallback, per-issuer JWKS resolvers (no cache pollution), and
// provenance stamping (auth.source). That stamp fed a conversation-tool gate
// (agentReply), retired in slice B4 (ADR-0028 amendment 2026-07-18) — nothing
// gates on it today, so these assertions now pin the stamp itself, not a gate.
//
// Each issuer gets its own real keypair + a COUNTING local JWKS resolver, so
// every assertion can also prove WHICH issuer's key set was consulted — the
// unit that pins "never a fallback to the other issuer".

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import type { RequestContext } from "../context/request-context.mjs";
import { AuthenticationError } from "./auth-middleware.mjs";
import { buildMultiIssuerAuthMiddleware, supabaseIssuerOf } from "./multi-issuer-auth.mjs";

const SUPABASE_URL = "https://test-project.supabase.co";
const SUPABASE_ISSUER = supabaseIssuerOf(SUPABASE_URL); // .../auth/v1
const SUPABASE_AUDIENCE = "authenticated";

const OIDC_ISSUER = "https://tenant.okta.example/oauth2/default";
const OIDC_AUDIENCE = "api://labre-mcp";

const CONTEXT: RequestContext = {
  projectId: "multi-auth-test",
  projectRoot: "/tmp/multi-auth-test",
  sessionId: "s-multi-1",
  domain: "wardley",
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface IssuerFixture {
  key: CryptoKey;
  /** Counting resolver: proves which issuer's JWKS a verification consulted. */
  jwks: JWTVerifyGetKey;
  calls: () => number;
}

async function buildIssuerFixture(): Promise<IssuerFixture> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const localSet = createLocalJWKSet({ keys: [{ ...jwk, alg: "ES256", use: "sig" }] });
  let count = 0;
  const jwks: JWTVerifyGetKey = (header, input) => {
    count += 1;
    return localSet(header, input);
  };
  return { key: privateKey, jwks, calls: () => count };
}

interface SignOptions {
  issuer?: string; // undefined → NO iss claim
  audience?: string;
  sub?: string;
  role?: string;
}

function signWith(key: CryptoKey, options: SignOptions): Promise<string> {
  let jwt = new SignJWT({ role: options.role })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(options.sub ?? "user-1")
    .setAudience(options.audience ?? SUPABASE_AUDIENCE)
    .setExpirationTime("5m");
  if (options.issuer !== undefined) jwt = jwt.setIssuer(options.issuer);
  return jwt.sign(key);
}

describe("multi-issuer auth middleware (issue #33)", () => {
  let supabase: IssuerFixture;
  let oidc: IssuerFixture;

  beforeEach(async () => {
    supabase = await buildIssuerFixture();
    oidc = await buildIssuerFixture();
  });

  function middleware() {
    return buildMultiIssuerAuthMiddleware({
      supabase: { supabaseUrl: SUPABASE_URL, jwks: supabase.jwks },
      oidc: { jwks: oidc.jwks, audience: OIDC_AUDIENCE, issuer: OIDC_ISSUER },
    });
  }

  it("routes a Supabase-issued token to the Supabase JWKS and stamps source 'supabase'", async () => {
    const token = await signWith(supabase.key, {
      issuer: SUPABASE_ISSUER,
      sub: "user-supa",
      role: "authenticated",
    });
    const ctx = await middleware().authenticate(bearer(token), CONTEXT);
    assert.deepEqual(ctx.auth, {
      userId: "user-supa",
      role: "authenticated",
      token, // RLS pass-through: the raw bearer is threaded, Supabase family only
      source: "supabase",
    });
    assert.equal(supabase.calls(), 1, "the Supabase JWKS must be consulted");
    assert.equal(oidc.calls(), 0, "the OIDC JWKS must never see a Supabase-issued token");
  });

  it("derives the same Supabase issuer with or without a trailing slash on SUPABASE_URL", async () => {
    // Availability hardening: an env URL written with a trailing slash must
    // not silently reroute the whole Supabase population to the OIDC branch.
    assert.equal(supabaseIssuerOf(`${SUPABASE_URL}/`), SUPABASE_ISSUER);
    assert.equal(supabaseIssuerOf(SUPABASE_URL), SUPABASE_ISSUER);

    // End to end: a middleware configured with the slashed URL still routes a
    // genuine Supabase-issued token to the Supabase JWKS.
    const mw = buildMultiIssuerAuthMiddleware({
      supabase: { supabaseUrl: `${SUPABASE_URL}/`, jwks: supabase.jwks },
      oidc: { jwks: oidc.jwks, audience: OIDC_AUDIENCE, issuer: OIDC_ISSUER },
    });
    const token = await signWith(supabase.key, { issuer: SUPABASE_ISSUER });
    const ctx = await mw.authenticate(bearer(token), CONTEXT);
    assert.equal(ctx.auth?.source, "supabase");
    assert.equal(oidc.calls(), 0);
  });

  it("routes an OIDC-issued token to the OIDC JWKS and stamps source 'oidc'", async () => {
    const token = await signWith(oidc.key, {
      issuer: OIDC_ISSUER,
      audience: OIDC_AUDIENCE,
      sub: "user-oidc",
    });
    const ctx = await middleware().authenticate(bearer(token), CONTEXT);
    assert.equal(ctx.auth?.userId, "user-oidc");
    assert.equal(ctx.auth?.source, "oidc");
    assert.equal(ctx.auth?.token, token);
    assert.equal(oidc.calls(), 1, "the OIDC JWKS must be consulted");
    assert.equal(supabase.calls(), 0, "the Supabase JWKS must never see an OIDC-issued token");
  });

  it("unknown iss → 401 before ANY JWKS is consulted (no fallback)", async () => {
    const token = await signWith(oidc.key, { issuer: "https://evil.example" });
    await assert.rejects(middleware().authenticate(bearer(token), CONTEXT), AuthenticationError);
    assert.equal(supabase.calls(), 0);
    assert.equal(oidc.calls(), 0);
  });

  it("missing iss → 401 (routing is impossible, fail closed)", async () => {
    const token = await signWith(supabase.key, { issuer: undefined });
    await assert.rejects(middleware().authenticate(bearer(token), CONTEXT), AuthenticationError);
    assert.equal(supabase.calls(), 0);
    assert.equal(oidc.calls(), 0);
  });

  it("non-JWT bearer → 401 (not routable)", async () => {
    await assert.rejects(
      middleware().authenticate(bearer("not.a.jwt"), CONTEXT),
      AuthenticationError,
    );
    await assert.rejects(middleware().authenticate({}, CONTEXT), AuthenticationError);
  });

  it("a Supabase-iss token that fails Supabase verification is NEVER retried on the OIDC issuer", async () => {
    // Signed with the OIDC key but claiming the Supabase iss: the Supabase
    // JWKS rejects the signature, and that failure is final.
    const forged = await signWith(oidc.key, { issuer: SUPABASE_ISSUER });
    await assert.rejects(middleware().authenticate(bearer(forged), CONTEXT), AuthenticationError);
    assert.equal(supabase.calls(), 1, "only the Supabase JWKS is consulted");
    assert.equal(oidc.calls(), 0, "no cross-issuer fallback");
  });

  it("an OIDC-iss token that fails OIDC verification is NEVER retried on the Supabase issuer", async () => {
    const forged = await signWith(supabase.key, { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE });
    await assert.rejects(middleware().authenticate(bearer(forged), CONTEXT), AuthenticationError);
    assert.equal(oidc.calls(), 1, "only the OIDC JWKS is consulted");
    assert.equal(supabase.calls(), 0, "no cross-issuer fallback");
  });

  it("JWKS unavailable → 401, still no fallback to the other issuer", async () => {
    // A resolver that throws stands in for an unreachable JWKS endpoint —
    // jwtVerify surfaces it, the middleware maps it to AuthenticationError.
    const down: JWTVerifyGetKey = () => {
      throw new Error("JWKS endpoint unreachable");
    };
    const mw = buildMultiIssuerAuthMiddleware({
      supabase: { supabaseUrl: SUPABASE_URL, jwks: down },
      oidc: { jwks: oidc.jwks, audience: OIDC_AUDIENCE, issuer: OIDC_ISSUER },
    });
    const token = await signWith(supabase.key, { issuer: SUPABASE_ISSUER });
    await assert.rejects(mw.authenticate(bearer(token), CONTEXT), AuthenticationError);
    assert.equal(oidc.calls(), 0, "a Supabase-side outage never re-routes to the OIDC issuer");
  });

  it("per-issuer JWKS resolvers stay isolated across a mixed sequence (no cache pollution)", async () => {
    const mw = middleware();
    const supaToken = await signWith(supabase.key, { issuer: SUPABASE_ISSUER });
    const oidcToken = await signWith(oidc.key, { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE });

    await mw.authenticate(bearer(supaToken), CONTEXT);
    await mw.authenticate(bearer(oidcToken), CONTEXT);
    await mw.authenticate(bearer(supaToken), CONTEXT);

    assert.equal(supabase.calls(), 2, "Supabase resolver used exactly for the 2 Supabase calls");
    assert.equal(oidc.calls(), 1, "OIDC resolver used exactly for the 1 OIDC call");
  });

  it("without a configured OIDC issuer, non-Supabase iss routes to the OIDC verifier (single-oidc-mode semantics)", async () => {
    const mw = buildMultiIssuerAuthMiddleware({
      supabase: { supabaseUrl: SUPABASE_URL, jwks: supabase.jwks },
      // issuer deliberately unset — same trust model as today's single `oidc`
      // mode (the JWKS is the authority, issuer check optional).
      oidc: { jwks: oidc.jwks, audience: OIDC_AUDIENCE },
    });

    // A genuine IdP-signed token with an arbitrary iss verifies (multi-tenant IdP).
    const ok = await signWith(oidc.key, { issuer: "https://any.example", audience: OIDC_AUDIENCE });
    const ctx = await mw.authenticate(bearer(ok), CONTEXT);
    assert.equal(ctx.auth?.source, "oidc");

    // An unknown issuer's token still fails closed — its signature cannot
    // verify against the OIDC JWKS — and never touches the Supabase JWKS.
    const { privateKey: strangerKey } = await generateKeyPair("ES256");
    const stranger = await signWith(strangerKey, {
      issuer: "https://stranger.example",
      audience: OIDC_AUDIENCE,
    });
    await assert.rejects(mw.authenticate(bearer(stranger), CONTEXT), AuthenticationError);
    assert.equal(supabase.calls(), 0);
  });
});
