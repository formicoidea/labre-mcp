// TELEMETRY PARITY MATRIX — invariant I7 (AI-harness audit, CH-09).
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
import { dispatch } from "#transport/mcp-handler.mjs";
import { TOOL_CALL_EVENT } from "#transport/tool-telemetry.mjs";
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
