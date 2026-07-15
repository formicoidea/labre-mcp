import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import type { RequestContext } from "../context/request-context.mjs";
import { buildSupabaseAuthMiddleware } from "./supabase-auth.mjs";
import { AuthenticationError } from "./auth-middleware.mjs";

const SUPABASE_URL = "https://test-project.supabase.co";
const AUDIENCE = "authenticated";

const baseContext: RequestContext = {
  projectId: "auth-test",
  projectRoot: "/tmp/auth-test",
  sessionId: "s-auth-1",
  domain: "wardley",
};

interface SignOptions {
  sub?: string;
  role?: string;
  audience?: string;
  expiresAt?: number; // absolute unix seconds; default: +1h
}

describe("supabase auth middleware", () => {
  let signingKey: CryptoKey;
  let jwks: JWTVerifyGetKey;
  let foreignKey: CryptoKey;

  before(async () => {
    // Real ES256 keypair + local JWKS injected in place of the remote
    // Supabase endpoint — the verification path is identical.
    const pair = await generateKeyPair("ES256");
    signingKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    jwks = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "ES256", use: "sig" }] });

    const foreignPair = await generateKeyPair("ES256");
    foreignKey = foreignPair.privateKey;
  });

  async function sign(options: SignOptions = {}, key?: CryptoKey): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ role: options.role })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(options.sub ?? "user-123")
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt(now - 60)
      .setExpirationTime(options.expiresAt ?? now + 3600);
    return jwt.sign(key ?? signingKey);
  }

  function middleware() {
    return buildSupabaseAuthMiddleware({ supabaseUrl: SUPABASE_URL, jwks });
  }

  it("valid token enriches the context with userId and role", async () => {
    const token = await sign({ sub: "user-abc", role: "authenticated" });
    const context = await middleware().authenticate(
      { authorization: `Bearer ${token}` },
      baseContext,
    );
    // auth.token is the verified raw bearer, threaded for RLS pass-through
    // tools ([A2] agent.reply) — see jwks-auth.mts (auth review). auth.source
    // is the provenance stamp (issue #33): this preset always says 'supabase'.
    assert.deepEqual(context.auth, {
      userId: "user-abc",
      role: "authenticated",
      token,
      source: "supabase",
    });
    // Original context fields are preserved.
    assert.equal(context.projectId, baseContext.projectId);
    assert.equal(context.sessionId, baseContext.sessionId);
  });

  it("role is optional in the token", async () => {
    const token = await sign({ sub: "user-norole" });
    const context = await middleware().authenticate(
      { authorization: `Bearer ${token}` },
      baseContext,
    );
    assert.equal(context.auth?.userId, "user-norole");
    assert.equal(context.auth?.role, undefined);
  });

  it("authorization header lookup is case-insensitive", async () => {
    const token = await sign();
    const context = await middleware().authenticate(
      { Authorization: `Bearer ${token}` },
      baseContext,
    );
    assert.equal(context.auth?.userId, "user-123");
  });

  it("expired token throws AuthenticationError", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ expiresAt: now - 120 });
    await assert.rejects(
      middleware().authenticate({ authorization: `Bearer ${token}` }, baseContext),
      AuthenticationError,
    );
  });

  it("wrong audience throws AuthenticationError", async () => {
    const token = await sign({ audience: "some-other-audience" });
    await assert.rejects(
      middleware().authenticate({ authorization: `Bearer ${token}` }, baseContext),
      AuthenticationError,
    );
  });

  it("missing authorization header throws AuthenticationError", async () => {
    await assert.rejects(middleware().authenticate({}, baseContext), AuthenticationError);
  });

  it("garbage header value throws AuthenticationError", async () => {
    await assert.rejects(
      middleware().authenticate({ authorization: "not-a-bearer-token" }, baseContext),
      AuthenticationError,
    );
    await assert.rejects(
      middleware().authenticate({ authorization: "Bearer not.a.jwt" }, baseContext),
      AuthenticationError,
    );
  });

  it("token signed by a different key throws AuthenticationError", async () => {
    const token = await sign({}, foreignKey);
    await assert.rejects(
      middleware().authenticate({ authorization: `Bearer ${token}` }, baseContext),
      AuthenticationError,
    );
  });

  it("token without a sub claim throws AuthenticationError", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setAudience(AUDIENCE)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 3600)
      .sign(signingKey);
    await assert.rejects(
      middleware().authenticate({ authorization: `Bearer ${token}` }, baseContext),
      AuthenticationError,
    );
  });
});
