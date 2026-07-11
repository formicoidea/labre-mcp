import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPostHog,
  recipeFlagKey,
  promptExperimentFlagKey,
  PROMPT_EXPERIMENT_FLAG_PREFIX,
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
  allFlags?: Record<string, string | boolean> | undefined;
  failAllFlags?: boolean;
}): PostHogClientLike & {
  flagCalls: Array<{ key: string; distinctId: string }>;
  allFlagsCalls: string[];
  captured: CapturedEvent[];
  shutdownCalls: number;
} {
  const flagCalls: Array<{ key: string; distinctId: string }> = [];
  const allFlagsCalls: string[] = [];
  const captured: CapturedEvent[] = [];
  const state = { shutdownCalls: 0 };
  return {
    flagCalls,
    allFlagsCalls,
    captured,
    get shutdownCalls() {
      return state.shutdownCalls;
    },
    async isFeatureEnabled(key, distinctId) {
      flagCalls.push({ key, distinctId });
      if (args.failFlags) throw new Error("posthog unreachable");
      return args.verdict;
    },
    async getAllFlags(distinctId) {
      allFlagsCalls.push(distinctId);
      if (args.failAllFlags) throw new Error("posthog unreachable");
      return args.allFlags;
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

describe("promptExperimentFlagKey", () => {
  it("prefixes the strategyId with mcp-prompt-", () => {
    assert.equal(promptExperimentFlagKey("evolve-a"), "mcp-prompt-evolve-a");
    assert.equal(PROMPT_EXPERIMENT_FLAG_PREFIX, "mcp-prompt-");
  });

  it("never lets a colon through", () => {
    const key = promptExperimentFlagKey("wardley:iteration:observe");
    assert.equal(key, "mcp-prompt-wardley-iteration-observe");
    assert.ok(!key.includes(":"));
  });

  it("round-trips: slicing the prefix recovers a colon-free strategyId", () => {
    const key = promptExperimentFlagKey("strat-1");
    assert.equal(key.slice(PROMPT_EXPERIMENT_FLAG_PREFIX.length), "strat-1");
  });
});

describe("buildPostHog.resolvePromptVariants", () => {
  it("keeps only mcp-prompt- string flags and strips the prefix to recover the strategyId", async () => {
    const client = buildFakeClient({
      allFlags: {
        "mcp-prompt-strat-1": "variant-bold",
        "mcp-prompt-strat-2": "variant-terse",
        "mcp-recipe-wardley-map-x": "some-value", // wrong prefix → ignored
        "unrelated-flag": "nope", // no prefix → ignored
      },
    });
    const flags = buildPostHog({ apiKey: "phc_test", client });
    const variants = await flags.resolvePromptVariants("user-1");
    assert.deepEqual(variants, {
      "strat-1": "variant-bold",
      "strat-2": "variant-terse",
    });
    // getAllFlags is called exactly once, with the distinctId.
    assert.deepEqual(client.allFlagsCalls, ["user-1"]);
  });

  it("ignores boolean-valued flags under the prompt prefix (rollout toggles, not variants)", async () => {
    const client = buildFakeClient({
      allFlags: {
        "mcp-prompt-strat-1": true, // boolean → not a variant selector
        "mcp-prompt-strat-2": false,
        "mcp-prompt-strat-3": "variant-c",
      },
    });
    const flags = buildPostHog({ apiKey: "phc_test", client });
    const variants = await flags.resolvePromptVariants("user-1");
    assert.deepEqual(variants, { "strat-3": "variant-c" });
  });

  it("recovers the strategyId even when it contains dashes", async () => {
    const client = buildFakeClient({
      allFlags: { "mcp-prompt-wardley-iteration-observe": "v1" },
    });
    const flags = buildPostHog({ apiKey: "phc_test", client });
    const variants = await flags.resolvePromptVariants("user-1");
    assert.deepEqual(variants, { "wardley-iteration-observe": "v1" });
  });

  it("fails open to {} when getAllFlags returns undefined", async () => {
    const flags = buildPostHog({
      apiKey: "phc_test",
      client: buildFakeClient({ allFlags: undefined }),
    });
    assert.deepEqual(await flags.resolvePromptVariants("user-1"), {});
  });

  it("fails open to {} when the client throws", async () => {
    const flags = buildPostHog({
      apiKey: "phc_test",
      client: buildFakeClient({ failAllFlags: true }),
    });
    assert.deepEqual(await flags.resolvePromptVariants("user-1"), {});
  });

  it("returns {} when there are no prompt flags at all", async () => {
    const flags = buildPostHog({
      apiKey: "phc_test",
      client: buildFakeClient({ allFlags: { "mcp-recipe-a-b-c": true } }),
    });
    assert.deepEqual(await flags.resolvePromptVariants("user-1"), {});
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

describe("buildPostHog.resolveRecipeVariant", () => {
  it("returns the string variant for a multivariate mcp-recipe- flag", async () => {
    const client = buildFakeClient({
      allFlags: { "mcp-recipe-wardley-map-draw-value-chain": "draw-value-chain-b" },
    });
    const flags = buildPostHog({ apiKey: "phc_test", client });
    assert.equal(await flags.resolveRecipeVariant(REF, "user-1"), "draw-value-chain-b");
    assert.deepEqual(client.allFlagsCalls, ["user-1"]);
  });

  it("returns undefined for a boolean flag (rollout gate, not a variant)", async () => {
    const client = buildFakeClient({
      allFlags: { "mcp-recipe-wardley-map-draw-value-chain": true },
    });
    const flags = buildPostHog({ apiKey: "phc_test", client });
    assert.equal(await flags.resolveRecipeVariant(REF, "user-1"), undefined);
  });

  it("returns undefined when the flag is absent", async () => {
    const flags = buildPostHog({ apiKey: "phc_test", client: buildFakeClient({ allFlags: {} }) });
    assert.equal(await flags.resolveRecipeVariant(REF, "user-1"), undefined);
  });

  it("fails open to undefined when PostHog returns no data", async () => {
    const flags = buildPostHog({
      apiKey: "phc_test",
      client: buildFakeClient({ allFlags: undefined }),
    });
    assert.equal(await flags.resolveRecipeVariant(REF, "user-1"), undefined);
  });

  it("fails open to undefined when PostHog is unreachable", async () => {
    const flags = buildPostHog({ apiKey: "phc_test", client: buildFakeClient({ failAllFlags: true }) });
    assert.equal(await flags.resolveRecipeVariant(REF, "user-1"), undefined);
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
