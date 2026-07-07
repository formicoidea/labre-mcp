import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPostHog,
  recipeFlagKey,
  type PostHogClientLike,
} from "./posthog.mjs";

interface CapturedEvent {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

// Injectable fake — records calls, returns a scripted flag verdict.
function buildFakeClient(args: {
  verdict?: boolean | undefined;
  failFlags?: boolean;
  failCapture?: boolean;
  failShutdown?: boolean;
}): PostHogClientLike & {
  flagCalls: Array<{ key: string; distinctId: string }>;
  captured: CapturedEvent[];
  shutdownCalls: number;
} {
  const flagCalls: Array<{ key: string; distinctId: string }> = [];
  const captured: CapturedEvent[] = [];
  const state = { shutdownCalls: 0 };
  return {
    flagCalls,
    captured,
    get shutdownCalls() {
      return state.shutdownCalls;
    },
    async isFeatureEnabled(key, distinctId) {
      flagCalls.push({ key, distinctId });
      if (args.failFlags) throw new Error("posthog unreachable");
      return args.verdict;
    },
    capture(message) {
      if (args.failCapture) throw new Error("capture exploded");
      captured.push(message);
    },
    async shutdown() {
      state.shutdownCalls += 1;
      if (args.failShutdown) throw new Error("flush failed");
    },
  };
}

const REF = { domain: "wardley", tool: "map", name: "draw-value-chain" };

describe("recipeFlagKey", () => {
  it("joins the 3 segments with dashes under the mcp-recipe prefix", () => {
    assert.equal(recipeFlagKey(REF), "mcp-recipe-wardley-map-draw-value-chain");
  });

  it("never lets a colon through", () => {
    const key = recipeFlagKey({ domain: "a:b", tool: "c", name: "d:e" });
    assert.equal(key, "mcp-recipe-a-b-c-d-e");
    assert.ok(!key.includes(":"));
  });
});

describe("buildPostHog.isRecipeEnabled", () => {
  it("returns true when the flag is enabled", async () => {
    const client = buildFakeClient({ verdict: true });
    const flags = buildPostHog({ apiKey: "phc_test", client });
    assert.equal(await flags.isRecipeEnabled(REF, "user-1"), true);
    assert.deepEqual(client.flagCalls, [
      { key: "mcp-recipe-wardley-map-draw-value-chain", distinctId: "user-1" },
    ]);
  });

  it("returns false when the flag is explicitly disabled", async () => {
    const flags = buildPostHog({ apiKey: "phc_test", client: buildFakeClient({ verdict: false }) });
    assert.equal(await flags.isRecipeEnabled(REF, "user-1"), false);
  });

  it("fails open when the flag is undefined in PostHog", async () => {
    const flags = buildPostHog({
      apiKey: "phc_test",
      client: buildFakeClient({ verdict: undefined }),
    });
    assert.equal(await flags.isRecipeEnabled(REF, "user-1"), true);
  });

  it("fails open when PostHog is unreachable", async () => {
    const flags = buildPostHog({ apiKey: "phc_test", client: buildFakeClient({ failFlags: true }) });
    assert.equal(await flags.isRecipeEnabled(REF, "user-1"), true);
  });

  it("falls back to the anonymous distinctId when userId is undefined", async () => {
    const client = buildFakeClient({ verdict: true });
    const flags = buildPostHog({ apiKey: "phc_test", client });
    await flags.isRecipeEnabled(REF, undefined);
    assert.equal(client.flagCalls[0]?.distinctId, "anonymous");
  });
});

describe("buildPostHog.capture", () => {
  it("forwards the event to the client", async () => {
    const client = buildFakeClient({});
    const flags = buildPostHog({ apiKey: "phc_test", client });
    flags.capture("mcp_run_end", "user-1", { recipeRunId: "r1" });
    // capture is fire-and-forget — yield to the microtask queue before asserting.
    await Promise.resolve();
    assert.deepEqual(client.captured, [
      { distinctId: "user-1", event: "mcp_run_end", properties: { recipeRunId: "r1" } },
    ]);
  });

  it("never throws, even when the client capture explodes", async () => {
    const flags = buildPostHog({ apiKey: "phc_test", client: buildFakeClient({ failCapture: true }) });
    assert.doesNotThrow(() => flags.capture("mcp_step_error", "user-1"));
    await Promise.resolve(); // the rejected microtask must be swallowed too
  });
});

describe("buildPostHog.shutdown", () => {
  it("flushes the client and swallows flush failures", async () => {
    const client = buildFakeClient({ failShutdown: true });
    const flags = buildPostHog({ apiKey: "phc_test", client });
    await assert.doesNotReject(() => flags.shutdown());
    assert.equal(client.shutdownCalls, 1);
  });
});
