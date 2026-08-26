// The costume at the DISPATCH (CH-24 / ARCH-28) — protocol shaping only.
//
// This file tests the transport's half: that the four methods answer in MCP
// shape, that the handshake advertises exactly the surfaces it was handed, and
// that an unknown id comes back as a clean JSON-RPC error rather than a throw.
// It uses hand-built registries, not labre's — the wire must serve whatever it
// is handed and name none of it (ARCH-27). The Wardley costume itself is
// pinned in src/mcp/ (costume-parity.test.mts).
//
// NO LLM, NO NETWORK, NO DISK: the fixtures below are two constants.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PromptRegistry, requireArguments } from "#core/registry/prompt-registry.mjs";
import { ResourceRegistry } from "#core/registry/resource-registry.mjs";
import { ToolRegistry } from "#core/registry/tool-registry.mjs";
import type { RequestContext } from "#core/context/request-context.mjs";
import { dispatch, serverCapabilities } from "./mcp-handler.mjs";
import { JsonRpcErrorCode } from "./json-rpc.schema.mjs";

const context: RequestContext = {
  projectId: "proj-costume-dispatch",
  projectRoot: process.cwd(),
  sessionId: "session-costume-dispatch",
  domain: "wardley",
};

const ARGUMENTS = [
  { name: "component", description: "The component to place.", required: true },
  { name: "context", description: "Business context.", required: false },
];

function buildPrompts(): PromptRegistry {
  const registry = new PromptRegistry();
  registry.register({
    name: "place-component",
    title: "Place a component",
    description: "Fixture prompt.",
    arguments: ARGUMENTS,
    render(args) {
      requireArguments("place-component", ARGUMENTS, args);
      return [
        { role: "user", text: "METHOD" },
        { role: "user", text: `component=${args.component} context=${args.context ?? ""}` },
      ];
    },
  });
  return registry;
}

function buildResources(): ResourceRegistry {
  const registry = new ResourceRegistry();
  registry.register({
    uri: "labre://fixture",
    name: "fixture",
    title: "Fixture",
    description: "Fixture resource.",
    mimeType: "application/json",
    async read() {
      return '{"ok":true}';
    },
  });
  return registry;
}

// any: JSON-RPC result shapes are validated by the assertions themselves
async function call(method: string, params?: unknown, withCostume = true): Promise<any> {
  return dispatch({
    request: { jsonrpc: "2.0", id: 1, method, params },
    context,
    tools: new ToolRegistry(),
    prompts: withCostume ? buildPrompts() : undefined,
    resources: withCostume ? buildResources() : undefined,
  });
}

describe("handshake — capabilities describe what this process can answer", () => {
  it("advertises prompts and resources when the delivery handed them over", async () => {
    const response = await call("initialize");
    assert.deepEqual(Object.keys(response.result.capabilities).sort(), [
      "experimental",
      "logging",
      "prompts",
      "resources",
      "tools",
    ]);
  });

  it("advertises neither when the delivery handed neither", async () => {
    // A capability is a promise. One made for a surface that will answer
    // MethodNotFound is a lie a client acts on.
    const response = await call("initialize", undefined, false);
    assert.deepEqual(Object.keys(response.result.capabilities).sort(), [
      "experimental",
      "logging",
      "tools",
    ]);
  });

  it("declares each surface independently", () => {
    assert.ok("prompts" in serverCapabilities({ prompts: buildPrompts() }));
    assert.ok(!("resources" in serverCapabilities({ prompts: buildPrompts() })));
    assert.ok("resources" in serverCapabilities({ resources: buildResources() }));
    assert.ok(!("prompts" in serverCapabilities({ resources: buildResources() })));
  });
});

describe("prompts/list + prompts/get", () => {
  it("lists prompts in MCP shape", async () => {
    const response = await call("prompts/list");
    assert.deepEqual(response.result.prompts, [
      {
        name: "place-component",
        title: "Place a component",
        description: "Fixture prompt.",
        arguments: ARGUMENTS,
      },
    ]);
  });

  it("renders a prompt into MCP text messages", async () => {
    const response = await call("prompts/get", {
      name: "place-component",
      arguments: { component: "kettle", context: "tea shop" },
    });
    assert.equal(response.result.description, "Fixture prompt.");
    assert.deepEqual(response.result.messages, [
      { role: "user", content: { type: "text", text: "METHOD" } },
      { role: "user", content: { type: "text", text: "component=kettle context=tea shop" } },
    ]);
  });

  it("stringifies non-string arguments rather than rejecting them", async () => {
    const response = await call("prompts/get", {
      name: "place-component",
      arguments: { component: 42, context: { a: 1 } },
    });
    assert.equal(
      response.result.messages[1].content.text,
      'component=42 context={"a":1}',
    );
  });

  it("answers InvalidParams on an unknown prompt name", async () => {
    const response = await call("prompts/get", { name: "no-such-prompt" });
    assert.equal(response.error.code, JsonRpcErrorCode.InvalidParams);
    assert.match(response.error.message, /Unknown prompt: no-such-prompt/);
  });

  it("answers InvalidParams when 'name' is missing", async () => {
    const response = await call("prompts/get", {});
    assert.equal(response.error.code, JsonRpcErrorCode.InvalidParams);
  });

  it("answers InvalidParams — not a crash — on a missing required argument", async () => {
    const response = await call("prompts/get", { name: "place-component", arguments: {} });
    assert.equal(response.error.code, JsonRpcErrorCode.InvalidParams);
    assert.match(response.error.message, /\["component"\]/);
    // The message names the argument, never a value the caller sent.
    assert.ok(!response.error.message.includes("kettle"));
  });

  it("treats a null argument as absent", async () => {
    const response = await call("prompts/get", {
      name: "place-component",
      arguments: { component: null },
    });
    assert.equal(response.error.code, JsonRpcErrorCode.InvalidParams);
  });

  it("is MethodNotFound when no prompt registry was handed over", async () => {
    const response = await call("prompts/list", undefined, false);
    assert.equal(response.error.code, JsonRpcErrorCode.MethodNotFound);
  });
});

describe("resources/list + resources/read", () => {
  it("lists resources in MCP shape", async () => {
    const response = await call("resources/list");
    assert.deepEqual(response.result.resources, [
      {
        uri: "labre://fixture",
        name: "fixture",
        title: "Fixture",
        description: "Fixture resource.",
        mimeType: "application/json",
      },
    ]);
  });

  it("reads a resource into MCP contents", async () => {
    const response = await call("resources/read", { uri: "labre://fixture" });
    assert.deepEqual(response.result.contents, [
      { uri: "labre://fixture", mimeType: "application/json", text: '{"ok":true}' },
    ]);
  });

  it("answers the MCP ResourceNotFound code on an unknown URI", async () => {
    // NOT MethodNotFound: the method exists and was understood; the document
    // does not. A client distinguishes the two.
    const response = await call("resources/read", { uri: "labre://nope" });
    assert.equal(response.error.code, JsonRpcErrorCode.ResourceNotFound);
    assert.match(response.error.message, /Unknown resource: labre:\/\/nope/);
  });

  it("answers InvalidParams when 'uri' is missing", async () => {
    const response = await call("resources/read", {});
    assert.equal(response.error.code, JsonRpcErrorCode.InvalidParams);
  });

  it("is MethodNotFound when no resource registry was handed over", async () => {
    const response = await call("resources/read", { uri: "labre://fixture" }, false);
    assert.equal(response.error.code, JsonRpcErrorCode.MethodNotFound);
  });
});

describe("registry contracts", () => {
  it("refuse a duplicate name / uri", () => {
    const prompts = buildPrompts();
    assert.throws(
      () =>
        prompts.register({
          name: "place-component",
          title: "x",
          description: "x",
          arguments: [],
          render: () => [],
        }),
      /already registered/,
    );
    const resources = buildResources();
    assert.throws(
      () =>
        resources.register({
          uri: "labre://fixture",
          name: "x",
          title: "x",
          description: "x",
          mimeType: "text/plain",
          read: async () => "",
        }),
      /already registered/,
    );
  });
});
