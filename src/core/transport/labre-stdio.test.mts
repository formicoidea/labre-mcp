// Unit tests for the stdio transport line handler. These exercise the
// transport framing only (parse, validate, dispatch routing) without spawning
// a process or touching real strategies — tools/list and ping never invoke a
// handler, so no LLM/network is hit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLine } from "./labre-stdio.mjs";
import { buildBootRegistry } from "./boot-tool-registry.mjs";
import type { JsonRpcResponse } from "./json-rpc.schema.mjs";

function resultOf(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res && "result" in res, "expected a success response");
  return res.result as Record<string, unknown>;
}

function toolPayload<T>(res: JsonRpcResponse | null): T {
  const result = resultOf(res) as { content?: Array<{ type: string; text: string }> };
  assert.ok(Array.isArray(result.content), "expected MCP CallToolResult content array");
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse(result.content[0].text) as T;
}

test("ping returns an empty result with the matching id", async () => {
  const tools = buildBootRegistry();
  const res = await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    { tools },
  );
  assert.deepEqual(res, { jsonrpc: "2.0", id: 1, result: {} });
});

test("tools/list advertises the four boot tools", async () => {
  const tools = buildBootRegistry();
  const res = await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    { tools },
  );
  const list = resultOf(res).tools as Array<{ name: string }>;
  const names = list.map((t) => t.name);
  assert.deepEqual(
    names.sort(),
    ["__ping__", "estimateEvolution", "runCommand", "runRecipe"].sort(),
  );
});

test("initialize advertises labre-mcp server info", async () => {
  const tools = buildBootRegistry();
  const res = await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize" }),
    { tools },
  );
  const info = resultOf(res).serverInfo as { name: string };
  assert.equal(info.name, "labre-mcp");
});

test("tools/call returns MCP content array for the smoke tool", async () => {
  const tools = buildBootRegistry();
  const res = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "__ping__", arguments: { message: "hello" } },
    }),
    { tools },
  );
  const payload = toolPayload<{
    result: { echoed: { message: string }; daemon: string };
    degraded: boolean;
    degradationEvents: unknown[];
  }>(res);
  assert.equal(payload.degraded, false);
  assert.deepEqual(payload.degradationEvents, []);
  assert.equal(payload.result.echoed.message, "hello");
  assert.equal(payload.result.daemon, "labre-mcp");
});

test("malformed JSON yields a -32700 parse error (id null)", async () => {
  const tools = buildBootRegistry();
  const res = await handleLine("{ not json", { tools });
  assert.ok(res && "error" in res);
  assert.equal(res.error.code, -32700);
  assert.equal(res.id, null);
});

test("a structurally invalid request yields -32600", async () => {
  const tools = buildBootRegistry();
  const res = await handleLine(JSON.stringify({ id: 9, method: "ping" }), { tools });
  assert.ok(res && "error" in res);
  assert.equal(res.error.code, -32600);
});

test("notifications produce no response", async () => {
  const tools = buildBootRegistry();
  const res = await handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    { tools },
  );
  assert.equal(res, null);
});

test("blank lines are ignored", async () => {
  const tools = buildBootRegistry();
  assert.equal(await handleLine("   ", { tools }), null);
  assert.equal(await handleLine("", { tools }), null);
});

test("unknown tool yields a method-not-found error", async () => {
  const tools = buildBootRegistry();
  const res = await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }),
    { tools },
  );
  assert.ok(res && "error" in res);
  assert.equal(res.error.code, -32601);
});
