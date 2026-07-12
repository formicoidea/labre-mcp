import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import "#lib/prompts/init.mjs";
import { buildApp } from "./http-server.mjs";
import { buildBootRegistry } from "./labre-daemon.mjs";
import { noopAuthMiddleware, AuthenticationError } from "./auth-middleware.mjs";
import { buildSupabaseAuthMiddleware } from "./supabase-auth.mjs";

function buildTestApp() {
  return buildApp({ tools: buildBootRegistry(), auth: noopAuthMiddleware });
}

async function rpcCall(app: ReturnType<typeof buildApp>, body: unknown): Promise<unknown> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return null;
  return res.json();
}

function toolPayload<T>(response: { result: { content: Array<{ type: string; text: string }> } }): T {
  assert.ok(Array.isArray(response.result.content));
  assert.equal(response.result.content[0]?.type, "text");
  return JSON.parse(response.result.content[0].text) as T;
}

describe("labre-mcp HTTP transport", () => {
  it("GET /health responds ok", async () => {
    const app = buildTestApp();
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ok");
  });

  it("GET /version returns server info", async () => {
    const app = buildTestApp();
    const res = await app.request("/version");
    const body = (await res.json()) as { name: string; version: string };
    assert.equal(body.name, "labre-mcp");
  });

  it("MCP ping returns empty success", async () => {
    const app = buildTestApp();
    const response = (await rpcCall(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    })) as { id: number; result: unknown };
    assert.equal(response.id, 1);
    assert.deepEqual(response.result, {});
  });

  it("MCP initialize returns server info + capabilities", async () => {
    const app = buildTestApp();
    const response = (await rpcCall(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1.0" } },
    })) as { result: { serverInfo: { name: string }; capabilities: object } };
    assert.equal(response.result.serverInfo.name, "labre-mcp");
    assert.ok(response.result.capabilities);
  });

  it("MCP tools/list returns the registered tools", async () => {
    const app = buildTestApp();
    const response = (await rpcCall(app, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    })) as { result: { tools: Array<{ name: string }> } };
    assert.ok(response.result.tools.length >= 1);
    assert.ok(response.result.tools.some((t) => t.name === "__ping__"));
  });

  it("MCP tools/call invokes the smoke tool", async () => {
    const app = buildTestApp();
    const response = (await rpcCall(app, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "__ping__", arguments: { message: "hello" } },
    })) as { result: { content: Array<{ type: string; text: string }>; structuredContent: unknown } };
    const payload = toolPayload<{
      result: { echoed: { message: string }; daemon: string };
      degraded: boolean;
      degradationEvents: unknown[];
    }>(response);
    assert.deepEqual(response.result.structuredContent, payload);
    assert.equal(payload.degraded, false);
    assert.deepEqual(payload.degradationEvents, []);
    assert.equal(payload.result.echoed.message, "hello");
    assert.equal(payload.result.daemon, "labre-mcp");
  });

  it("MCP unknown tool returns method-not-found error", async () => {
    const app = buildTestApp();
    const response = (await rpcCall(app, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "does-not-exist" },
    })) as { error: { code: number; message: string } };
    assert.equal(response.error.code, -32601);
  });

  it("notifications return 204 with no body", async () => {
    const app = buildTestApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(res.status, 204);
  });

  it("invalid JSON returns parse error", async () => {
    const app = buildTestApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{",
    });
    assert.equal(res.status, 400);
  });

  it("MCP estimateEvolution via tools/call runs the recipe end-to-end", async () => {
    // Setup: temp project root with override recipe that uses s-curve only
    // (deterministic, no LLM call required).
    const projectRoot = await mkdtemp(join(tmpdir(), "labre-http-m12-"));
    const recipeDir = join(projectRoot, "recipes", "wardley", "map");
    await mkdir(recipeDir, { recursive: true });
    await writeFile(
      join(recipeDir, "estimate-component-evolution.recipe.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "estimate-component-evolution",
        domain: "wardley",
        tool: "map",
        description: "TEST override — s-curve only",
        steps: [
          {
            stepId: "estimate",
            tool: "wardley:map:climate:position-functional-in-evolution:s-curve",
            in: "$.input",
            out: "$.estimate",
          },
        ],
        listeners: {},
      }),
      "utf8",
    );
    const artifactDir = join(projectRoot, ".artifacts");
    await mkdir(artifactDir, { recursive: true });

    const app = buildTestApp();
    const response = (await rpcCall(app, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "estimateEvolution",
        arguments: {
          name: "CRM",
          certitude: 0.85,
          ubiquity: 0.6,
          _context: {
            projectId: "m12-http",
            projectRoot,
            sessionId: "s-http-1",
            domain: "wardley",
            artifactDir,
          },
        },
      },
    })) as {
      id: number;
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: unknown;
      };
    };

    assert.equal(response.id, 100);
    const payload = toolPayload<{
      degraded: boolean;
      result: {
        recipeRunId: string;
        artifactPath: string | null;
        ast: { estimate?: { result?: { method: string } } };
        events: Array<{ phase: string }>;
      };
    }>(response);
    assert.deepEqual(response.result.structuredContent, payload);
    assert.equal(payload.degraded, false);
    const inner = payload.result;
    assert.ok(inner.recipeRunId.length > 0);
    assert.equal(
      inner.ast.estimate?.result?.method,
      "wardley:map:climate:position-functional-in-evolution:s-curve",
    );
    const phases = inner.events.map((e) => e.phase);
    assert.ok(phases.includes("step-start"));
    assert.ok(phases.includes("step-end"));
    assert.ok(phases.includes("run-end"));

    // Verify artefact written
    assert.ok(inner.artifactPath !== null);
    const artifactJson = JSON.parse(
      await readFile(inner.artifactPath as string, "utf8"),
    );
    assert.equal(artifactJson.projectId, "m12-http");
    assert.equal(artifactJson.sessionId, "s-http-1");
  });
});

describe("labre-mcp GET /config/llm (ops endpoint)", () => {
  const ADMIN_TOKEN = "ops-secret-token";
  const STUB_CONFIG = {
    defaultProvider: "opencode",
    providers: {
      opencode: { kind: "http-api", baseUrl: "https://x", apiKeyEnv: "OPENCODE_API_KEY" },
      claude: { kind: "agent-sdk" },
    },
    strategies: {
      "some:strategy": { provider: "opencode", model: "kimi-k2.5", topLogprobs: 5 },
    },
  } as unknown as import("#lib/llm/config.schema.mjs").LLMConfig;

  function buildConfigApp() {
    return buildApp({
      tools: buildBootRegistry(),
      auth: noopAuthMiddleware,
      loadConfig: () => STUB_CONFIG,
    });
  }

  it("returns 503 when LABRE_MCP_ADMIN_TOKEN is unset", async () => {
    delete process.env.LABRE_MCP_ADMIN_TOKEN;
    const res = await buildConfigApp().request("/config/llm");
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "config endpoint disabled" });
  });

  it("returns 401 with a missing or wrong bearer token", async () => {
    process.env.LABRE_MCP_ADMIN_TOKEN = ADMIN_TOKEN;
    try {
      const noHeader = await buildConfigApp().request("/config/llm");
      assert.equal(noHeader.status, 401);
      const wrong = await buildConfigApp().request("/config/llm", {
        headers: { authorization: "Bearer nope" },
      });
      assert.equal(wrong.status, 401);
    } finally {
      delete process.env.LABRE_MCP_ADMIN_TOKEN;
    }
  });

  it("returns 200 with the resolved config and per-provider hasKey (no secret values)", async () => {
    process.env.LABRE_MCP_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.OPENCODE_API_KEY = "sk-live-should-not-leak";
    try {
      const res = await buildConfigApp().request("/config/llm", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        defaultProvider: string;
        providers: Record<string, { kind: string; apiKeyEnv?: string; hasKey: boolean }>;
        strategies: Record<string, { provider: string; model: string }>;
      };
      assert.equal(body.defaultProvider, "opencode");
      assert.equal(body.providers.opencode.apiKeyEnv, "OPENCODE_API_KEY");
      assert.equal(body.providers.opencode.hasKey, true);
      // No env var set for the agent-sdk provider → hasKey false.
      assert.equal(body.providers.claude.hasKey, false);
      assert.equal(body.strategies["some:strategy"].model, "kimi-k2.5");
      // Secret values never appear anywhere in the payload.
      assert.ok(!JSON.stringify(body).includes("sk-live-should-not-leak"));
    } finally {
      delete process.env.LABRE_MCP_ADMIN_TOKEN;
      delete process.env.OPENCODE_API_KEY;
    }
  });
});

describe("labre-mcp HTTP transport with supabase auth", () => {
  async function buildAuthedApp() {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "ES256", use: "sig" }] });
    const app = buildApp({
      tools: buildBootRegistry(),
      auth: buildSupabaseAuthMiddleware({ supabaseUrl: "https://test.supabase.co", jwks }),
    });
    return { app, privateKey };
  }

  it("missing token returns 401 with JSON-RPC code -32001", async () => {
    const { app } = await buildAuthedApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 7);
    assert.equal(body.error.code, -32001);
    assert.equal(body.error.message, "unauthorized");
  });

  it("valid token dispatches normally", async () => {
    const { app, privateKey } = await buildAuthedApp();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("user-http-1")
      .setAudience("authenticated")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: number; result: unknown };
    assert.equal(body.id, 8);
    assert.deepEqual(body.result, {});
  });

  it("onAuthenticated hook runs after auth with the raw headers and enriched context", async () => {
    const seen: Array<{ authorization?: string; userId?: string }> = [];
    const app = buildApp({
      tools: buildBootRegistry(),
      auth: {
        async authenticate(_headers, context) {
          return { ...context, auth: { userId: "user-hook-1" } };
        },
      },
      onAuthenticated: async (headers, context) => {
        seen.push({ authorization: headers["authorization"], userId: context.auth?.userId });
      },
    });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping" }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, "Bearer caller-token");
    assert.equal(seen[0].userId, "user-hook-1");
  });

  it("onAuthenticated hook failure does not fail the request", async () => {
    const app = buildApp({
      tools: buildBootRegistry(),
      auth: noopAuthMiddleware,
      onAuthenticated: async () => {
        throw new Error("bundle refresh exploded");
      },
    });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: number; result: unknown };
    assert.equal(body.id, 11);
    assert.deepEqual(body.result, {});
  });

  it("noop middleware still accepts header-less requests", async () => {
    const app = buildApp({ tools: buildBootRegistry(), auth: noopAuthMiddleware });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: number; result: unknown };
    assert.equal(body.id, 9);
    assert.deepEqual(body.result, {});
  });
});

describe("labre-mcp OAuth protected-resource discovery (RFC 9728)", () => {
  const OAUTH = {
    resource: "https://framework-mcp.labre.app/mcp",
    authServer: "https://labre.app",
  };
  const METADATA_URL =
    "https://framework-mcp.labre.app/.well-known/oauth-protected-resource";

  // A middleware that always rejects, to exercise the 401 WWW-Authenticate path
  // without needing a real token.
  const rejectingAuth = {
    async authenticate(): Promise<never> {
      throw new AuthenticationError("no token");
    },
  };

  it("serves the protected-resource metadata when configured", async () => {
    const app = buildApp({ tools: buildBootRegistry(), auth: noopAuthMiddleware, oauth: OAUTH });
    const res = await app.request("/.well-known/oauth-protected-resource");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(body.resource, OAUTH.resource);
    assert.deepEqual(body.authorization_servers, [OAUTH.authServer]);
  });

  it("stamps a 401 with WWW-Authenticate pointing at the resource metadata", async () => {
    const app = buildApp({ tools: buildBootRegistry(), auth: rejectingAuth, oauth: OAUTH });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get("WWW-Authenticate"),
      `Bearer resource_metadata="${METADATA_URL}"`,
    );
  });

  it("is fully off when unconfigured: no well-known route, plain 401", async () => {
    const app = buildApp({ tools: buildBootRegistry(), auth: rejectingAuth });
    const wellKnown = await app.request("/.well-known/oauth-protected-resource");
    assert.equal(wellKnown.status, 404);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("WWW-Authenticate"), null);
  });
});
