import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "../context/request-context.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { AuthenticationError } from "./auth-middleware.mjs";
import {
  buildApiKeyAuthMiddleware,
  routeBearerAuth,
  API_KEY_PREFIX,
  type ApiKeyValidator,
} from "./api-key-auth.mjs";

const baseContext: RequestContext = {
  projectId: "apikey-test",
  projectRoot: "/tmp/apikey-test",
  sessionId: "s-apikey-1",
  domain: "wardley",
};

const OPTIONS = { supabaseUrl: "https://test-project.supabase.co", anonKey: "anon-key" };

function headersWith(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

describe("api-key auth middleware", () => {
  it("resolves a valid key to its owner on the context", async () => {
    const middleware = buildApiKeyAuthMiddleware({
      ...OPTIONS,
      validate: async () => ({ userId: "user-42" }),
    });
    const context = await middleware.authenticate(headersWith("lab_valid"), baseContext);
    assert.equal(context.auth?.userId, "user-42");
  });

  it("rejects an unknown/revoked/expired key", async () => {
    const middleware = buildApiKeyAuthMiddleware({
      ...OPTIONS,
      validate: async () => undefined,
    });
    await assert.rejects(
      middleware.authenticate(headersWith("lab_revoked"), baseContext),
      AuthenticationError,
    );
  });

  it("fails closed when the validator itself fails", async () => {
    const middleware = buildApiKeyAuthMiddleware({
      ...OPTIONS,
      validate: async () => {
        throw new Error("network down");
      },
    });
    await assert.rejects(
      middleware.authenticate(headersWith("lab_whatever"), baseContext),
      AuthenticationError,
    );
  });

  it("rejects a missing authorization header", async () => {
    const middleware = buildApiKeyAuthMiddleware({
      ...OPTIONS,
      validate: async () => ({ userId: "user-42" }),
    });
    await assert.rejects(middleware.authenticate({}, baseContext), AuthenticationError);
  });

  it("caches a successful validation within the TTL", async () => {
    let calls = 0;
    const validate: ApiKeyValidator = async () => {
      calls += 1;
      return { userId: "user-42" };
    };
    const middleware = buildApiKeyAuthMiddleware({ ...OPTIONS, validate, cacheTtlMs: 60_000 });
    await middleware.authenticate(headersWith("lab_cached"), baseContext);
    await middleware.authenticate(headersWith("lab_cached"), baseContext);
    assert.equal(calls, 1);
  });

  it("does not cache failures — a key created after a miss works immediately", async () => {
    let known = false;
    const validate: ApiKeyValidator = async () => (known ? { userId: "user-42" } : undefined);
    const middleware = buildApiKeyAuthMiddleware({ ...OPTIONS, validate });
    await assert.rejects(middleware.authenticate(headersWith("lab_new"), baseContext));
    known = true;
    const context = await middleware.authenticate(headersWith("lab_new"), baseContext);
    assert.equal(context.auth?.userId, "user-42");
  });

  it("re-validates once the TTL has elapsed (revocation takes effect)", async () => {
    let calls = 0;
    const validate: ApiKeyValidator = async () => {
      calls += 1;
      return calls === 1 ? { userId: "user-42" } : undefined;
    };
    const middleware = buildApiKeyAuthMiddleware({ ...OPTIONS, validate, cacheTtlMs: 0 });
    await middleware.authenticate(headersWith("lab_ttl"), baseContext);
    await assert.rejects(middleware.authenticate(headersWith("lab_ttl"), baseContext));
  });
});

describe("routeBearerAuth", () => {
  const marker = (name: string): AuthMiddleware => ({
    async authenticate(_headers, context) {
      return { ...context, auth: { userId: name } };
    },
  });

  it("routes lab_ bearers to the api-key middleware", async () => {
    const routed = routeBearerAuth(marker("jwt"), marker("apikey"));
    const context = await routed.authenticate(headersWith(`${API_KEY_PREFIX}abc`), baseContext);
    assert.equal(context.auth?.userId, "apikey");
  });

  it("routes JWT-shaped bearers to the jwt middleware", async () => {
    const routed = routeBearerAuth(marker("jwt"), marker("apikey"));
    const context = await routed.authenticate(headersWith("eyJhbGciOi.payload.sig"), baseContext);
    assert.equal(context.auth?.userId, "jwt");
  });

  it("routes missing bearers to the jwt middleware (canonical 401)", async () => {
    const jwt: AuthMiddleware = {
      async authenticate() {
        throw new AuthenticationError("missing authorization header");
      },
    };
    const routed = routeBearerAuth(jwt, marker("apikey"));
    await assert.rejects(routed.authenticate({}, baseContext), AuthenticationError);
  });
});
