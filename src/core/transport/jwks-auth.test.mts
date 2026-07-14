// Generic JWKS middleware — provider-neutral behaviors NOT already exercised
// by supabase-auth.test.mts (which now runs through the same core): issuer
// enforcement, custom role claim, config validation. An Okta-shaped token
// (custom audience, issuer URL, namespaced role claim) doubles as the
// multi-provider smoke.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { buildJwksAuthMiddleware } from "./jwks-auth.mjs";
import { AuthenticationError } from "./auth-middleware.mjs";
import type { RequestContext } from "../context/request-context.mjs";

const CONTEXT: RequestContext = {
  projectId: "p",
  projectRoot: "/tmp/p",
  sessionId: "s",
  domain: "wardley",
};

const ISSUER = "https://tenant.okta.example/oauth2/default";
const AUDIENCE = "api://labre-mcp";
const ROLE_CLAIM = "https://labre.example/role";

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "ES256";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts?: { issuer?: string }) => {
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("user-1")
      .setAudience(AUDIENCE)
      .setExpirationTime("5m");
    if (opts?.issuer !== undefined) jwt = jwt.setIssuer(opts.issuer);
    return jwt.sign(privateKey);
  };
  return { jwks, sign };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("buildJwksAuthMiddleware (generic OIDC core)", () => {
  test("enforces the issuer when configured", async () => {
    const { jwks, sign } = await setup();
    const mw = buildJwksAuthMiddleware({ jwks, audience: AUDIENCE, issuer: ISSUER });

    const good = await sign({}, { issuer: ISSUER });
    const ctx = await mw.authenticate(bearer(good), CONTEXT);
    assert.equal(ctx.auth?.userId, "user-1");

    const wrong = await sign({}, { issuer: "https://evil.example" });
    await assert.rejects(mw.authenticate(bearer(wrong), CONTEXT), AuthenticationError);

    const missing = await sign({});
    await assert.rejects(mw.authenticate(bearer(missing), CONTEXT), AuthenticationError);
  });

  test("reads the role from a custom (namespaced) claim", async () => {
    const { jwks, sign } = await setup();
    const mw = buildJwksAuthMiddleware({ jwks, audience: AUDIENCE, roleClaim: ROLE_CLAIM });

    const token = await sign({ [ROLE_CLAIM]: "analyst", role: "ignored-default" });
    const ctx = await mw.authenticate(bearer(token), CONTEXT);
    assert.equal(ctx.auth?.role, "analyst");
  });

  test("non-string role claim values leave role undefined", async () => {
    const { jwks, sign } = await setup();
    const mw = buildJwksAuthMiddleware({ jwks, audience: AUDIENCE, roleClaim: ROLE_CLAIM });

    const token = await sign({ [ROLE_CLAIM]: ["group-a", "group-b"] });
    const ctx = await mw.authenticate(bearer(token), CONTEXT);
    assert.equal(ctx.auth?.userId, "user-1");
    assert.equal(ctx.auth?.role, undefined);
  });

  test("requires jwksUrl or an injected jwks resolver", () => {
    assert.throws(() => buildJwksAuthMiddleware({ audience: AUDIENCE }), /jwksUrl/);
  });

  // ⚠ AUTH REVIEW coverage — the [A2] token-threading change: a VERIFIED JWT
  // is retained on context.auth.token for RLS pass-through tools (agent.reply).
  // Only this middleware sets it; api-key-auth (lab_ keys) never does.
  test("threads the verified raw bearer as auth.token (RLS pass-through)", async () => {
    const { jwks, sign } = await setup();
    const mw = buildJwksAuthMiddleware({ jwks, audience: AUDIENCE });

    const token = await sign({});
    const ctx = await mw.authenticate(bearer(token), CONTEXT);
    assert.equal(ctx.auth?.token, token);
  });
});
