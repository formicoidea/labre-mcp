// TELEMETRY PARITY MATRIX — invariant I7 (AI-harness audit, CH-09; extended to
// the costume by CH-24).
//
// WHAT THIS PINS. The audit found telemetry on ONE of the five tool paths:
// runRecipe emitted, runCommand and the three business tools were mute. That
// was not a bug anyone wrote — it was a bug nobody could see, because nothing
// stated what "instrumented" meant across the surface. This file states it: one
// table, every registered MCP tool, the telemetry each must emit, checked by
// actually dispatching each tool with a PostHog stub installed.
//
// THE BASELINE IS EXACT, in both directions (same discipline as the CH-06
// import guard). A tool registered but absent from the table fails the first
// test — so a sixth tool cannot ship silently unmeasured; the author is forced
// to add a row and prove it emits. A row for a tool that no longer exists fails
// too, so the table cannot rot into fiction.
//
// NO MODEL IS CALLED, and none may ever be: this test runs in the CI `test`
// job. Each tool is dispatched with arguments that fail its own Zod schema, so
// the handler rejects in memory — no strategy, no filesystem, no provider. That
// exercises the error path on purpose: the wrapper lives at the dispatch, so if
// it emits when a handler throws it emits when a handler succeeds (__ping__
// covers the success path). The RUN-level events (mcp_run_end / mcp_step_error)
// come from the kernel bus and need a real recipe run, so they are covered by
// the listener's own unit test, not here.
//
// WHY IT LIVES IN src/mcp/ rather than beside the dispatcher: it enumerates the
// tool descriptors, and `src/core/transport/` may not import `src/mcp/`
// (CH-06 boundary guard). The wire surface may know the kernel; not the reverse.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { PostHogFlags } from "#lib/flags/posthog.mjs";
import { setPostHogFlags } from "#lib/flags/state.mjs";
import type { RequestContext } from "#core/context/request-context.mjs";
import { buildMcpToolRegistry } from "./tool-registry.mjs";
import { buildMcpPromptRegistry } from "./prompt-registry.mjs";
import { buildMcpResourceRegistry } from "./resource-registry.mjs";
import { dispatch } from "#transport/mcp-handler.mjs";
import { COSTUME_CALL_EVENT, TOOL_CALL_EVENT } from "#transport/tool-telemetry.mjs";
import { GRAMMAR_URI, METHODS_URI, RECIPES_URI } from "./resource-registry.mjs";
import { ESTIMATE_EVOLUTION_RECIPE_REF } from "./estimate-evolution.tool.mjs";
import { EVALUATE_MAP_RECIPE_REF } from "./evaluate-map.tool.mjs";
import { GENERATE_VALUE_CHAIN_RECIPE_REF } from "./generate-value-chain.tool.mjs";
import { RUN_COMMAND_TOOL } from "./run-command.tool.mjs";
import { RUN_RECIPE_TOOL } from "./run-recipe.tool.mjs";

interface MatrixRow {
  /** Arguments to dispatch with. Invalid on purpose except for __ping__ — see header. */
  args: Record<string, unknown>;
  /** Events this tool must emit for that call, in order. */
  events: string[];
  /** Expected `status` property on the mcp_tool_call event. */
  status: "ok" | "error";
  /**
   * Expected `target` property, or null when the tool declares none / cannot
   * resolve one from these arguments. The three business tools each dispatch a
   * FIXED recipe, so their target is a constant and survives invalid input;
   * runCommand and runRecipe read theirs from the (here invalid) call.
   */
  target: string | null;
}

/** The parity table. One row per REGISTERED MCP tool — no more, no less. */
const TELEMETRY_MATRIX: Record<string, MatrixRow> = {
  __ping__: {
    args: { message: "hello" },
    events: [TOOL_CALL_EVENT],
    status: "ok",
    target: null,
  },
  estimateEvolution: {
    args: {},
    events: [TOOL_CALL_EVENT],
    status: "error",
    target: ESTIMATE_EVOLUTION_RECIPE_REF,
  },
  evaluateMap: {
    args: {},
    events: [TOOL_CALL_EVENT],
    status: "error",
    target: EVALUATE_MAP_RECIPE_REF,
  },
  generateValueChain: {
    args: {},
    events: [TOOL_CALL_EVENT],
    status: "error",
    target: GENERATE_VALUE_CHAIN_RECIPE_REF,
  },
  runCommand: {
    args: { command: "not-a-five-segment-method-id", input: {} },
    events: [TOOL_CALL_EVENT],
    status: "error",
    target: null,
  },
  runRecipe: {
    args: { recipe: "not-a-three-segment-ref", input: {} },
    events: [TOOL_CALL_EVENT],
    status: "error",
    target: null,
  },
};

interface Captured {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}

/** PostHog stub: records capture() and nothing else. No network, no client. */
function buildRecordingFlags(): PostHogFlags & { captured: Captured[] } {
  const captured: Captured[] = [];
  return {
    captured,
    async isRecipeEnabled() {
      return true;
    },
    async resolveRecipeVariant() {
      return undefined;
    },
    async resolvePromptVariants() {
      return {};
    },
    capture(event, distinctId, properties) {
      captured.push({ event, distinctId, properties });
    },
    async shutdown() {},
  };
}

const context: RequestContext = {
  projectId: "proj-telemetry-matrix",
  projectRoot: process.cwd(),
  sessionId: "session-telemetry-matrix",
  domain: "wardley",
};

afterEach(() => {
  // The flags singleton is process-wide — never leave it installed for the
  // next test file.
  setPostHogFlags(undefined);
});

describe("telemetry parity matrix (I7) — the table itself", () => {
  it("covers every registered tool, and only registered tools", () => {
    const registered = buildMcpToolRegistry()
      .list()
      .map((tool) => tool.name)
      .sort();
    const declared = Object.keys(TELEMETRY_MATRIX).sort();
    assert.deepEqual(
      registered,
      declared,
      "Telemetry parity baseline broken. A tool was added to (or removed from) " +
        "buildMcpToolRegistry without updating TELEMETRY_MATRIX. Every MCP tool must " +
        "emit telemetry on every transport (invariant I7): add the row and let the " +
        "matrix prove the tool emits — do not delete the assertion.",
    );
  });
});

describe("telemetry parity matrix (I7) — every tool emits", () => {
  for (const [toolName, row] of Object.entries(TELEMETRY_MATRIX)) {
    it(`${toolName} emits ${row.events.join(" + ")}`, async () => {
      const flags = buildRecordingFlags();
      setPostHogFlags(flags);

      await dispatch({
        request: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: toolName, arguments: row.args },
        },
        context,
        tools: buildMcpToolRegistry(),
        transport: "stdio",
      });

      assert.deepEqual(
        flags.captured.map((c) => c.event),
        row.events,
        `${toolName} did not emit the events the parity matrix requires`,
      );

      const toolCall = flags.captured.find((c) => c.event === TOOL_CALL_EVENT);
      assert.ok(toolCall, `${toolName} emitted no ${TOOL_CALL_EVENT}`);
      const props = toolCall.properties ?? {};
      assert.equal(props.tool, toolName);
      assert.equal(props.status, row.status);
      // The transport travels with the event: parity across the two wires is a
      // claim that has to be checkable in the data, not just in the code.
      assert.equal(props.transport, "stdio");
      assert.equal(typeof props.durationMs, "number");
      assert.equal(typeof props.degraded, "boolean");
      assert.equal(props.target ?? null, row.target);
      // Unauthenticated context → the shared constant distinct id.
      assert.equal(toolCall.distinctId, "daemon");
    });
  }

  it("emits nothing at all when no PostHog is configured", async () => {
    setPostHogFlags(undefined);
    // The absence of a client must be inert, not a crash: an unconfigured
    // process is the DEFAULT (local dev, stdio with no key).
    const response = await dispatch({
      request: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "__ping__", arguments: { message: "hello" } },
      },
      context,
      tools: buildMcpToolRegistry(),
    });
    assert.ok(response && "result" in response);
  });
});

describe("telemetry parity matrix (I7) — target extraction", () => {
  // The three business tools dispatch a fixed recipe, so their target is a
  // constant already asserted above. These two read theirs from the call: the
  // matrix dispatches them with INVALID arguments (no model, no filesystem), so
  // the valid-input case is proved on the extractor directly.
  it("runCommand reports the methodId it was handed", () => {
    assert.equal(
      RUN_COMMAND_TOOL.telemetryTarget?.({
        command: "wardley:map:climate:position-functional-in-evolution:s-curve",
        input: {},
      }),
      "wardley:map:climate:position-functional-in-evolution:s-curve",
    );
  });

  it("runRecipe reports the recipe ref it was handed", () => {
    assert.equal(
      RUN_RECIPE_TOOL.telemetryTarget?.({ recipe: "wardley:map:evaluate-map", input: {} }),
      "wardley:map:evaluate-map",
    );
  });

  it("refuses an unbounded caller string as a target (cardinality guard)", () => {
    // A PostHog property fed straight from caller input is a cardinality leak.
    // Anything that does not validate against the tool's own schema yields no
    // target rather than a free-text one.
    assert.equal(RUN_COMMAND_TOOL.telemetryTarget?.({ command: "whatever the caller typed" }), undefined);
    assert.equal(RUN_RECIPE_TOOL.telemetryTarget?.({ recipe: "whatever the caller typed" }), undefined);
    assert.equal(RUN_COMMAND_TOOL.telemetryTarget?.({}), undefined);
    assert.equal(RUN_RECIPE_TOOL.telemetryTarget?.(null), undefined);
  });
});

// ─── THE COSTUME (CH-24 / ARCH-28) ──────────────────────────────────────────
//
// Same discipline, second surface. `prompts/*` and `resources/*` are dispatched
// methods like `tools/call`, so they are pinned the same way: an EXACT baseline
// in both directions of what the delivery publishes, and a per-method proof
// that the dispatch measures it. The costume emits `mcp_costume_call`, not
// `mcp_tool_call` — folding a free catalogue read into the tool counter would
// inflate the very numbers CH-09 exists to make honest, so this table also
// asserts that the two events never cross.
//
// NO MODEL IS CALLED here either, and none can be: a prompt renders shipped
// text, a resource reads a shipped file. That is what makes the costume
// testable in the CI `test` job at all.

/** The prompt surface, exact. Six names, one selection criterion — the
 *  criterion is stated in prompt-registry.mts, this is its consequence. */
const COSTUME_PROMPT_BASELINE = [
  "anchor-evolution",
  "historical-evolution__with-capability",
  "identify-capability",
  "publication-analysis",
  "purpose-generate",
  "write-chain__top-down",
];

/** The resource surface, exact. Three catalogues plus one URI per published
 *  JSON Schema — the schema category is mechanical (whatever `schema/` holds),
 *  so `pnpm schemas` adding a file turns this red ON PURPOSE: a new public
 *  document is a decision, not a side effect. */
const COSTUME_RESOURCE_BASELINE = [
  "labre://grammar",
  "labre://methods",
  "labre://recipes",
  "labre://schemas/command-call",
  "labre://schemas/command-result",
  "labre://schemas/json-labre",
  "labre://schemas/wardley-map",
];

interface CostumeRow {
  params: Record<string, unknown> | undefined;
  /** Expected `status` on the mcp_costume_call event. */
  status: "ok" | "error";
  /** Expected `target`, or null when the call resolved no registry entry. */
  target: string | null;
}

/** One row per costume method — no more, no less. */
const COSTUME_MATRIX: Record<string, CostumeRow> = {
  "prompts/list": { params: undefined, status: "ok", target: null },
  "prompts/get": {
    params: { name: "identify-capability", arguments: { component: "kettle" } },
    status: "ok",
    target: "identify-capability",
  },
  "resources/list": { params: undefined, status: "ok", target: null },
  "resources/read": { params: { uri: GRAMMAR_URI }, status: "ok", target: GRAMMAR_URI },
};

async function buildCostume(): Promise<{
  prompts: ReturnType<typeof buildMcpPromptRegistry>;
  resources: Awaited<ReturnType<typeof buildMcpResourceRegistry>>;
}> {
  return {
    prompts: buildMcpPromptRegistry(),
    resources: await buildMcpResourceRegistry(),
  };
}

describe("telemetry parity matrix (I7) — the costume baseline", () => {
  it("publishes exactly the declared prompts", () => {
    assert.deepEqual(
      buildMcpPromptRegistry().list().map((p) => p.name),
      COSTUME_PROMPT_BASELINE,
      "Costume prompt baseline broken. A prompt was added to (or removed from) " +
        "COSTUME_PROMPTS without updating this table. Publishing a method to third-party " +
        "harnesses is a decision: state the selection criterion it meets (prompt-registry.mts " +
        "header) and add the row — do not delete the assertion.",
    );
  });

  it("publishes exactly the declared resources", async () => {
    const resources = await buildMcpResourceRegistry();
    assert.deepEqual(
      resources.list().map((r) => r.uri),
      COSTUME_RESOURCE_BASELINE,
      "Costume resource baseline broken. Either a catalogue resource changed, or `schema/` " +
        "gained/lost a file — the schema category mirrors that directory mechanically. " +
        "Add or remove the URI here deliberately.",
    );
  });

  it("keeps every prompt renderable and every resource readable", async () => {
    // A listed entry that cannot be served is worse than an absent one: the
    // client sees it, asks for it, and gets an error it cannot act on.
    const { prompts, resources } = await buildCostume();
    for (const summary of prompts.list()) {
      const prompt = prompts.get(summary.name);
      assert.ok(prompt, `${summary.name} listed but not resolvable`);
      const args = Object.fromEntries(
        summary.arguments.filter((a) => a.required).map((a) => [a.name, `<${a.name}>`]),
      );
      const messages = prompt.render(args);
      assert.ok(messages.length >= 1);
      // The invariant system half leads (MCP has no system role).
      assert.equal(messages[0].role, "user");
      assert.ok(messages[0].text.length > 0);
    }
    for (const summary of resources.list()) {
      const resource = resources.get(summary.uri);
      assert.ok(resource, `${summary.uri} listed but not resolvable`);
      const text = await resource.read();
      assert.ok(text.length > 0, `${summary.uri} read empty`);
      // Every costume resource is JSON today; parsing is the cheapest proof
      // that a published document is not a truncated file.
      JSON.parse(text);
    }
  });
});

describe("telemetry parity matrix (I7) — every costume method emits", () => {
  for (const [method, row] of Object.entries(COSTUME_MATRIX)) {
    it(`${method} emits exactly one ${COSTUME_CALL_EVENT}`, async () => {
      const flags = buildRecordingFlags();
      setPostHogFlags(flags);
      const { prompts, resources } = await buildCostume();

      const response = await dispatch({
        request: { jsonrpc: "2.0", id: 1, method, params: row.params },
        context,
        tools: buildMcpToolRegistry(),
        prompts,
        resources,
        transport: "http",
      });
      assert.ok(response && "result" in response, `${method} did not succeed`);

      assert.deepEqual(
        flags.captured.map((c) => c.event),
        [COSTUME_CALL_EVENT],
        `${method} must emit exactly one ${COSTUME_CALL_EVENT} and nothing else — ` +
          `in particular never ${TOOL_CALL_EVENT}: a free catalogue read is not a tool call.`,
      );
      const props = flags.captured[0].properties ?? {};
      assert.equal(props.method, method);
      assert.equal(props.status, row.status);
      assert.equal(props.transport, "http");
      assert.equal(typeof props.durationMs, "number");
      assert.equal(props.target ?? null, row.target);
      assert.equal(flags.captured[0].distinctId, "daemon");
    });
  }

  it("reports an unknown id as an error and attaches NO target", async () => {
    // The id came from the caller and nothing bounds it; a PostHog property fed
    // from it would be a cardinality leak (same rule as tool targets).
    const flags = buildRecordingFlags();
    setPostHogFlags(flags);
    const { prompts, resources } = await buildCostume();

    for (const request of [
      { method: "prompts/get", params: { name: "no-such-prompt" } },
      { method: "resources/read", params: { uri: "labre://no-such-resource" } },
    ]) {
      const response = await dispatch({
        request: { jsonrpc: "2.0", id: 1, ...request },
        context,
        tools: buildMcpToolRegistry(),
        prompts,
        resources,
        transport: "stdio",
      });
      assert.ok(response && "error" in response, `${request.method} should have errored`);
    }

    assert.deepEqual(flags.captured.map((c) => c.event), [COSTUME_CALL_EVENT, COSTUME_CALL_EVENT]);
    for (const captured of flags.captured) {
      assert.equal(captured.properties?.status, "error");
      assert.equal(captured.properties?.target, undefined);
    }
  });

  it("emits nothing at all when no PostHog is configured", async () => {
    setPostHogFlags(undefined);
    const { prompts, resources } = await buildCostume();
    const response = await dispatch({
      request: { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: METHODS_URI } },
      context,
      tools: buildMcpToolRegistry(),
      prompts,
      resources,
    });
    assert.ok(response && "result" in response);
  });
});

describe("telemetry parity matrix (I7) — the costume's content", () => {
  it("the methods catalogue reports real, mock and disabled counts", async () => {
    const resources = await buildMcpResourceRegistry();
    const text = await (resources.get(METHODS_URI) as { read: () => Promise<string> }).read();
    const doc = JSON.parse(text) as {
      counts: { total: number; real: number; mock: number; disabled: number };
      methods: Array<{ methodId: string; implementation: string }>;
    };
    assert.equal(doc.counts.total, doc.methods.length);
    assert.equal(doc.counts.real + doc.counts.mock, doc.counts.total);
    assert.ok(doc.counts.real > 0, "a catalogue with no real strategy would be a scaffold");
    assert.ok(doc.counts.mock > 0, "mocks exist today — the catalogue must say so");
  });

  it("the recipe catalogue names refs runRecipe accepts", async () => {
    const resources = await buildMcpResourceRegistry();
    const text = await (resources.get(RECIPES_URI) as { read: () => Promise<string> }).read();
    const doc = JSON.parse(text) as { recipes: Array<{ ref: string }> };
    assert.ok(doc.recipes.length > 0);
    for (const recipe of doc.recipes) {
      assert.equal(
        RUN_RECIPE_TOOL.telemetryTarget?.({ recipe: recipe.ref }),
        recipe.ref,
        `catalogued ref "${recipe.ref}" is not one runRecipe would accept`,
      );
    }
  });

  it("the grammar resource publishes the regex runCommand enforces", async () => {
    const resources = await buildMcpResourceRegistry();
    const text = await (resources.get(GRAMMAR_URI) as { read: () => Promise<string> }).read();
    const doc = JSON.parse(text) as { regex: string; segments: unknown[] };
    assert.equal(doc.segments.length, 5);
    // A caller obeying the published regex must produce something runCommand's
    // own validator accepts — otherwise the costume documents a grammar the
    // tools do not speak.
    const example = "wardley:map:value-chain:generate:top-down";
    assert.ok(new RegExp(doc.regex).test(example));
    assert.equal(RUN_COMMAND_TOOL.telemetryTarget?.({ command: example }), example);
  });
});
