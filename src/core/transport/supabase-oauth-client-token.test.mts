// Guard: a Supabase-issued JWT carrying a `client_id` claim is refused on
// every door that accepts Supabase JWTs.
//
// What it would have caught: labre's workspace connector rides the Supabase
// Auth OAuth 2.1 server, whose tokens are ordinary Supabase JWTs (same iss,
// same JWKS, aud "authenticated") plus a `client_id` claim naming the
// third-party app. Before this guard, the daemon's `supabase` door and the
// multi-issuer Supabase branch accepted such a token as a plain user session,
// so any app a user connected could call every MCP tool (and trigger the
// caller-token bundle refresh) in that user's name, outside the connector.
//
// What it must NOT break: labre's own oauth-as tokens (the framework-mcp
// connector) travel through the OIDC door and carry no `client_id` (payload
// is `scope` only, supabase/functions/oauth-as/signing.ts accessTokenSpec);
// generic OIDC IdPs (e.g. Cognito) stamp `client_id` on ordinary access
// tokens, so the OIDC door keeps accepting it. The refusal is a static 401:
// the internal reason never reaches the caller.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import "#lib/prompts/init.mjs";
import type { RequestContext } from "../context/request-context.mjs";
import { AuthenticationError } from "./auth-middleware.mjs";
import { buildSupabaseAuthMiddleware } from "./supabase-auth.mjs";
import { buildMultiIssuerAuthMiddleware, supabaseIssuerOf } from "./multi-issuer-auth.mjs";
import { buildApp } from "./http-server.mjs";
import { buildBootRegistry } from "./labre-daemon.mjs";

const SUPABASE_URL = "https://test-project.supabase.co";
const SUPABASE_ISSUER = supabaseIssuerOf(SUPABASE_URL);
const OIDC_ISSUER = "https://test-project.supabase.co/functions/v1/oauth-as";
const OIDC_AUDIENCE = "https://mcp.labre.example/mcp";

const CONTEXT: RequestContext = {
  projectId: "client-id-guard",
  projectRoot: "/tmp/client-id-guard",
  sessionId: "s-client-id-1",
  domain: "wardley",
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface Keys {
  key: CryptoKey;
  jwks: JWTVerifyGetKey;
}

async function keys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  return {
    key: privateKey,
    jwks: createLocalJWKSet({ keys: [{ ...jwk, alg: "ES256", use: "sig" }] }),
  };
}

async function sign(
  key: CryptoKey,
  claims: Record<string, unknown>,
  iss: string,
  aud: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(iss)
    .setSubject("user-1")
    .setAudience(aud)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 3600)
    .sign(key);
}

describe("Supabase OAuth client tokens (client_id claim) are refused", () => {
  let supa: Keys;
  let oidc: Keys;

  before(async () => {
    supa = await keys();
    oidc = await keys();
  });

  const supabaseSession = () =>
    sign(supa.key, { role: "authenticated" }, SUPABASE_ISSUER, "authenticated");
  const supabaseClientToken = (clientId: unknown) =>
    sign(supa.key, { role: "authenticated", client_id: clientId }, SUPABASE_ISSUER, "authenticated");

  function multi() {
    return buildMultiIssuerAuthMiddleware({
      supabase: { supabaseUrl: SUPABASE_URL, jwks: supa.jwks },
      oidc: { jwks: oidc.jwks, audience: OIDC_AUDIENCE, issuer: OIDC_ISSUER },
    });
  }

  it("single supabase door: refuses a token with client_id", async () => {
    const auth = buildSupabaseAuthMiddleware({ supabaseUrl: SUPABASE_URL, jwks: supa.jwks });
    const token = await supabaseClientToken("3f1c-app");
    await assert.rejects(auth.authenticate(bearer(token), CONTEXT), AuthenticationError);
  });

  it("single supabase door: refuses an empty-string client_id too", async () => {
    const auth = buildSupabaseAuthMiddleware({ supabaseUrl: SUPABASE_URL, jwks: supa.jwks });
    const token = await supabaseClientToken("");
    await assert.rejects(auth.authenticate(bearer(token), CONTEXT), AuthenticationError);
  });

  it("single supabase door: a plain user session still passes", async () => {
    const auth = buildSupabaseAuthMiddleware({ supabaseUrl: SUPABASE_URL, jwks: supa.jwks });
    const ctx = await auth.authenticate(bearer(await supabaseSession()), CONTEXT);
    assert.equal(ctx.auth?.userId, "user-1");
    assert.equal(ctx.auth?.source, "supabase");
  });

  it("multi-issuer Supabase branch: refuses a token with client_id", async () => {
    const token = await supabaseClientToken("3f1c-app");
    await assert.rejects(multi().authenticate(bearer(token), CONTEXT), AuthenticationError);
  });

  it("multi-issuer OIDC branch: an oauth-as token (scope only, no client_id) still passes", async () => {
    const token = await sign(oidc.key, { scope: "mcp" }, OIDC_ISSUER, OIDC_AUDIENCE);
    const ctx = await multi().authenticate(bearer(token), CONTEXT);
    assert.equal(ctx.auth?.source, "oidc");
  });

  it("multi-issuer OIDC branch: a generic IdP's client_id is not refused", async () => {
    const token = await sign(oidc.key, { client_id: "cognito-app" }, OIDC_ISSUER, OIDC_AUDIENCE);
    const ctx = await multi().authenticate(bearer(token), CONTEXT);
    assert.equal(ctx.auth?.source, "oidc");
  });

  it("HTTP: the refusal is a static 401 that names no reason, and no tool runs", async () => {
    const app = buildApp({
      tools: buildBootRegistry(),
      auth: buildSupabaseAuthMiddleware({ supabaseUrl: SUPABASE_URL, jwks: supa.jwks }),
    });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await supabaseClientToken("3f1c-app")}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "unauthorized" },
    });
    assert.ok(!text.includes("client"), "the internal refusal reason must not be reflected");
  });
});
