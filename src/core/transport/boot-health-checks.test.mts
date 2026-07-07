import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBootHealthChecks } from "./boot-health-checks.mjs";
import { clearRegistry, runHealthCheck } from "#lib/degradation/registry.mjs";
import { resetLLMConfigCache } from "#lib/llm/config.loader.mjs";
import { checkCopilotCliAvailable } from "#lib/llm/copilot-sdk-call.mjs";

const originalConfig = process.env.WARDLEY_LLM_CONFIG;

beforeEach(() => {
  clearRegistry();
  resetLLMConfigCache();
});

afterEach(() => {
  if (originalConfig === undefined) delete process.env.WARDLEY_LLM_CONFIG;
  else process.env.WARDLEY_LLM_CONFIG = originalConfig;
  clearRegistry();
  resetLLMConfigCache();
});

async function writeLlmConfig(content: unknown): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "labre-health-"));
  const path = join(dir, "llm.config.json");
  await writeFile(path, JSON.stringify(content), "utf8");
  process.env.WARDLEY_LLM_CONFIG = path;
}

describe("registerBootHealthChecks", () => {
  it("reports copilot-sdk degraded when the Copilot CLI package is unavailable", async () => {
    await writeLlmConfig({
      defaultProvider: "copilot",
      providers: { copilot: { kind: "copilot-sdk", authEnv: "COPILOT_GITHUB_TOKEN" } },
      strategies: { "write-chain": { provider: "copilot", model: "gpt-5" } },
    });
    registerBootHealthChecks();

    const event = await runHealthCheck("copilot-sdk");

    assert.ok(event);
    assert.equal(event.source, "copilot-sdk");
    assert.match(event.reason, /@github\/copilot CLI package is not installed/);
  });

  it("reports posthog by config presence only", async () => {
    const original = process.env.POSTHOG_API_KEY;
    try {
      delete process.env.POSTHOG_API_KEY;
      registerBootHealthChecks();
      const missing = await runHealthCheck("posthog");
      assert.ok(missing);
      assert.match(missing.reason, /POSTHOG_API_KEY not set/);

      process.env.POSTHOG_API_KEY = "phc_test";
      const ready = await runHealthCheck("posthog");
      assert.equal(ready, null); // ready checks emit no degradation event
    } finally {
      if (original === undefined) delete process.env.POSTHOG_API_KEY;
      else process.env.POSTHOG_API_KEY = original;
    }
  });
});

describe("checkCopilotCliAvailable", () => {
  it("is testable with an injected package resolver", () => {
    assert.deepEqual(
      checkCopilotCliAvailable(() => "mock-path"),
      { ready: true },
    );
    const missing = checkCopilotCliAvailable(() => {
      throw new Error("missing");
    });
    assert.equal(missing.ready, false);
    assert.match(missing.reason ?? "", /@github\/copilot CLI package/);
  });
});