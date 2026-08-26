// THE COSTUME, OVER A WIRE (CH-24 / ARCH-28).
//
// The dispatch's own unit tests (src/transport/costume-dispatch.test.mts) use
// hand-built fixtures, because the wire must serve whatever it is handed and
// name none of it. This file is the other half: labre's REAL costume, driven
// through the real Hono app and the real stdio line handler, so that what a
// third-party harness would actually receive is the thing under test.
//
// Three claims it settles, none of which the unit tests can:
//   1. The handshake ADVERTISES the costume — a client that reads capabilities
//      and sees no `prompts` never asks for one, so an unadvertised surface is
//      an absent surface.
//   2. Both wires expose the SAME costume (invariant I7). The two transports
//      differ in framing; a surface that differed between them would be a bug
//      nobody could see from either side alone.
//   3. The costume is behind the SAME auth door as tools/*. Nothing in CH-24
//      added a door, and this is what proves nothing removed one either: a
//      read-only method is still a method, and an unauthenticated daemon that
//      hands out its catalogue is an unauthenticated daemon.
//
// NO LLM, NO NETWORK: prompts render shipped text, resources read shipped
// files, and the auth section verifies a locally generated key.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import "#lib/prompts/init.mjs";
import { buildApp } from "#transport/http-server.mjs";
import { handleLine } from "#transport/stdio-server.mjs";
import { buildSupabaseAuthMiddleware } from "#transport/supabase-auth.mjs";
import { noopAuthMiddleware } from "#transport/auth-middleware.mjs";
import { buildMcpToolRegistry } from "./tool-registry.mjs";
import { buildMcpPromptRegistry } from "./prompt-registry.mjs";
import { buildMcpResourceRegistry, GRAMMAR_URI, METHODS_URI } from "./resource-registry.mjs";

async function buildCostumeApp(auth = noopAuthMiddleware) {
  return buildApp({
    tools: buildMcpToolRegistry(),
    prompts: buildMcpPromptRegistry(),
    resources: await buildMcpResourceRegistry(),
    auth,
  });
}

// any: JSON-RPC result shapes are validated by the assertions themselves
async function rpc(app: Awaited<ReturnType<typeof buildCostumeApp>>, body: unknown): Promise<any> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// any: same
async function stdio(method: string, params?: unknown): Promise<any> {
  return handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), {
    tools: buildMcpToolRegistry(),
    prompts: buildMcpPromptRegistry(),
    resources: await buildMcpResourceRegistry(),
  });
}

describe("costume over HTTP — the handshake advertises it", () => {
  it("initialize declares prompts and resources alongside tools", async () => {
    const app = await buildCostumeApp();
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1.0" } },
    });
    assert.deepEqual(Object.keys(response.result.capabilities).sort(), [
      "experimental",
      "logging",
      "prompts",
      "resources",
      "tools",
    ]);
  });
});

describe("costume over HTTP — MCP shapes", () => {
  it("prompts/list returns named, described, argument-carrying prompts", async () => {
    const app = await buildCostumeApp();
    const response = await rpc(app, { jsonrpc: "2.0", id: 2, method: "prompts/list" });
    const prompts = response.result.prompts as Array<{
      name: string;
      title: string;
      description: string;
      arguments: Array<{ name: string; description: string; required: boolean }>;
    }>;
    assert.ok(prompts.length >= 3);
    for (const prompt of prompts) {
      // Same charset rule as tool names (hard rule #24b): one invalid name and
      // claude.ai rejects the whole request of any conversation using it.
      assert.match(prompt.name, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.ok(prompt.title.length > 0);
      assert.ok(prompt.description.length > 0);
      assert.ok(prompt.arguments.length > 0, `${prompt.name} declares no argument`);
      assert.equal(
        prompt.arguments.filter((a) => a.required).length,
        1,
        `${prompt.name} must have exactly one required argument — its primary subject`,
      );
      for (const arg of prompt.arguments) assert.ok(arg.description.length > 0);
    }
  });

  it("prompts/get renders the method half first, then the interpolated half", async () => {
    const app = await buildCostumeApp();
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 3,
      method: "prompts/get",
      params: {
        name: "identify-capability",
        arguments: { component: "Tea kettle", description: "Boils water", context: "Tea shop" },
      },
    });
    const messages = response.result.messages as Array<{
      role: string;
      content: { type: string; text: string };
    }>;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content.type, "text");
    // The system half is the METHOD and carries no placeholder, by contract.
    assert.ok(!messages[0].content.text.includes("{{"));
    // The user half carries the caller's values, substituted.
    assert.match(messages[1].content.text, /Tea kettle/);
    assert.match(messages[1].content.text, /Tea shop/);
    assert.ok(!messages[1].content.text.includes("{{"));
  });

  it("resources/list returns labre:// URIs with mime types", async () => {
    const app = await buildCostumeApp();
    const response = await rpc(app, { jsonrpc: "2.0", id: 4, method: "resources/list" });
    const resources = response.result.resources as Array<{
      uri: string;
      name: string;
      title: string;
      description: string;
      mimeType: string;
    }>;
    assert.ok(resources.length >= 5);
    for (const resource of resources) {
      assert.match(resource.uri, /^labre:\/\/[a-z0-9-]+(\/[a-z0-9-]+)?$/);
      assert.ok(resource.description.length > 0);
      assert.match(resource.mimeType, /^application\/(json|schema\+json)$/);
    }
    const uris = resources.map((r) => r.uri);
    assert.ok(uris.includes(GRAMMAR_URI));
    assert.ok(uris.includes(METHODS_URI));
    assert.ok(uris.includes("labre://schemas/wardley-map"));
  });

  it("resources/read returns contents echoing the URI and mime type", async () => {
    const app = await buildCostumeApp();
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 5,
      method: "resources/read",
      params: { uri: "labre://schemas/wardley-map" },
    });
    const contents = response.result.contents as Array<{
      uri: string;
      mimeType: string;
      text: string;
    }>;
    assert.equal(contents.length, 1);
    assert.equal(contents[0].uri, "labre://schemas/wardley-map");
    assert.equal(contents[0].mimeType, "application/schema+json");
    const schema = JSON.parse(contents[0].text) as { $id?: string };
    assert.match(schema.$id ?? "", /wardley-map\.schema\.json$/);
  });

  it("answers an unknown id with a JSON-RPC error, not a crash", async () => {
    const app = await buildCostumeApp();
    const badPrompt = await rpc(app, {
      jsonrpc: "2.0",
      id: 6,
      method: "prompts/get",
      params: { name: "no-such-prompt" },
    });
    assert.equal(badPrompt.error.code, -32602);
    assert.equal(badPrompt.id, 6);

    const badResource = await rpc(app, {
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri: "labre://schemas/no-such-schema" },
    });
    assert.equal(badResource.error.code, -32002);
    assert.equal(badResource.id, 7);
  });
});

describe("costume parity across the two wires (I7)", () => {
  it("stdio exposes the same prompts and resources as HTTP", async () => {
    const app = await buildCostumeApp();
    const httpPrompts = (await rpc(app, { jsonrpc: "2.0", id: 8, method: "prompts/list" })).result
      .prompts as Array<{ name: string }>;
    const stdioPrompts = (await stdio("prompts/list")).result.prompts as Array<{ name: string }>;
    assert.deepEqual(
      stdioPrompts.map((p) => p.name),
      httpPrompts.map((p) => p.name),
    );

    const httpResources = (await rpc(app, { jsonrpc: "2.0", id: 9, method: "resources/list" }))
      .result.resources as Array<{ uri: string }>;
    const stdioResources = (await stdio("resources/list")).result.resources as Array<{
      uri: string;
    }>;
    assert.deepEqual(
      stdioResources.map((r) => r.uri),
      httpResources.map((r) => r.uri),
    );
  });

  it("stdio reads a resource identically", async () => {
    const response = await stdio("resources/read", { uri: GRAMMAR_URI });
    const doc = JSON.parse(response.result.contents[0].text) as { segments: unknown[] };
    assert.equal(doc.segments.length, 5);
  });
});

describe("costume behind the same auth door as tools/*", () => {
  async function buildAuthedApp() {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "ES256", use: "sig" }] });
    const app = await buildCostumeApp(
      buildSupabaseAuthMiddleware({ supabaseUrl: "https://test.supabase.co", jwks }),
    );
    return { app, privateKey };
  }

  for (const [method, params] of [
    ["prompts/list", undefined],
    ["prompts/get", { name: "identify-capability", arguments: { component: "x" } }],
    ["resources/list", undefined],
    ["resources/read", { uri: GRAMMAR_URI }],
  ] as const) {
    it(`${method} is refused 401 without a bearer`, async () => {
      const { app } = await buildAuthedApp();
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 10, method, params }),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: { code: number } };
      assert.equal(body.error.code, -32001);
    });
  }

  it("prompts/list succeeds with a valid bearer", async () => {
    const { app, privateKey } = await buildAuthedApp();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("user-costume")
      .setAudience("authenticated")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "prompts/list" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { prompts: unknown[] } };
    assert.ok(body.result.prompts.length > 0);
  });
});
