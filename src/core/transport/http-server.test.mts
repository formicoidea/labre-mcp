import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "#lib/prompts/init.mjs";
import { buildApp } from "./http-server.mjs";
import { buildBootRegistry } from "./labre-daemon.mjs";
import { noopAuthMiddleware } from "./auth-middleware.mjs";

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
      // Dispatch wraps every tool result in Degradable<T> ({ result, degraded, degradationEvents }).
    })) as { result: { result: { echoed: { message: string }; daemon: string }; degraded: boolean } };
    assert.equal(response.result.degraded, false);
    assert.equal(response.result.result.echoed.message, "hello");
    assert.equal(response.result.result.daemon, "labre-mcp");
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
      // Dispatch wraps the handler result in Degradable<T>.
      result: {
        degraded: boolean;
        result: {
          recipeRunId: string;
          artifactPath: string | null;
          ast: { estimate?: { result?: { method: string } } };
          events: Array<{ phase: string }>;
        };
      };
    };

    assert.equal(response.id, 100);
    assert.equal(response.result.degraded, false);
    const inner = response.result.result;
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
