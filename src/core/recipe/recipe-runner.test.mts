import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecipe } from "./recipe-runner.mjs";
import { StrategyRegistry } from "../registry/strategy-registry.mjs";
import { BaseStrategy, type StrategyResult } from "../ast/base-strategy.mjs";
import type { Recipe } from "./recipe.schema.mjs";
import type { RequestContext } from "../context/request-context.mjs";
import { recordLlmUsage } from "#lib/llm/usage-context.mjs";

// Strategy that reports LLM usage into the ambient collector (CP9). Two records
// per evaluate so a fanout/single run yields a deterministic aggregate.
class UsageReportingStrategy extends BaseStrategy<number, number> {
  static get method(): string {
    return "wardley:chain:write:capacity:usage";
  }
  async evaluate(input: number): Promise<StrategyResult<number>> {
    recordLlmUsage({ provider: "agent-sdk", model: "m", inputTokens: 10, outputTokens: 4 });
    recordLlmUsage({ provider: "agent-sdk", model: "m", inputTokens: 2, outputTokens: 1 });
    return { signals: [], reasoning: [], insights: [], result: input };
  }
}

// Strategy that emits a mix of numeric and non-numeric signals (CP10). Only the
// numeric ones must reach the run-end quality map.
class SignalEmittingStrategy extends BaseStrategy<number, number> {
  static get method(): string {
    return "wardley:chain:write:capacity:signals";
  }
  async evaluate(input: number): Promise<StrategyResult<number>> {
    const at = new Date().toISOString();
    return {
      signals: [
        { name: "confidence", value: 0.9, source: "computed", capturedAt: at },
        { name: "score", value: 42, source: "computed", capturedAt: at },
        { name: "label", value: "high", source: "computed", capturedAt: at }, // non-numeric: dropped
        { name: "confidence", value: 0.7, source: "computed", capturedAt: at }, // collision: last wins
      ],
      reasoning: [],
      insights: [],
      result: input,
    };
  }
}

class DoubleStrategy extends BaseStrategy<number, number> {
  static get method(): string {
    return "wardley:chain:write:capacity:double";
  }
  async evaluate(input: number): Promise<StrategyResult<number>> {
    return {
      signals: [{ name: "input", value: input, source: "user-input", capturedAt: new Date().toISOString() }],
      reasoning: [],
      insights: [],
      result: input * 2,
    };
  }
}

class SumStrategy extends BaseStrategy<number, number> {
  static get method(): string {
    return "wardley:chain:write:capacity:sum";
  }
  async evaluate(input: number): Promise<StrategyResult<number>> {
    return {
      signals: [],
      reasoning: [],
      insights: [],
      result: input + 100,
    };
  }
}

// Listener that observes its parent step's business result and emits an
// insight echoing it — used to assert listener wiring + envelope folding.
class InsightListener extends BaseStrategy<number, null> {
  static get method(): string {
    return "wardley:chain:audit:capacity:listen";
  }
  async evaluate(input: number): Promise<StrategyResult<null>> {
    return {
      signals: [],
      reasoning: [],
      insights: [{ text: `observed ${input}`, by: InsightListener.method, type: "other" }],
      result: null,
    };
  }
}

// Listener that always throws — used to assert failure isolation.
class ThrowingListener extends BaseStrategy<unknown, null> {
  static get method(): string {
    return "wardley:chain:audit:capacity:boom";
  }
  async evaluate(): Promise<StrategyResult<null>> {
    throw new Error("listener boom");
  }
}

class ThrowingStrategy extends BaseStrategy<unknown, null> {
  static get method(): string {
    return "wardley:chain:write:capacity:throw";
  }
  async evaluate(): Promise<StrategyResult<null>> {
    throw new Error("step boom");
  }
}

const ctx: RequestContext = {
  projectId: "p1",
  projectRoot: "/tmp/p1",
  sessionId: "s1",
  domain: "wardley",
};

describe("runRecipe", () => {
  it("runs a sequential pipeline writing to the AST", async () => {
    const registry = new StrategyRegistry();
    registry.register(DoubleStrategy.method, DoubleStrategy);
    registry.register(SumStrategy.method, SumStrategy);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "double-then-sum",
      domain: "wardley",
      tool: "chain",
      steps: [
        { stepId: "double", tool: DoubleStrategy.method, in: "$.value", out: "$.doubled" },
        { stepId: "sum", tool: SumStrategy.method, in: "$.doubled.result", out: "$.summed" },
      ],
      listeners: {},
    };

    const ast: Record<string, unknown> = { value: 5 };
    const outcome = await runRecipe({ recipe, ast, context: ctx, registry });

    const doubled = ast.doubled as { result: number };
    const summed = ast.summed as { result: number };
    assert.equal(doubled.result, 10);
    assert.equal(summed.result, 110);
    assert.ok(outcome.events.length >= 4); // 2 step-start + 2 step-end + run-end
    assert.equal(outcome.recipeRunId.length > 0, true);
  });

  it("auto-fans-out across an array via 'over'", async () => {
    const registry = new StrategyRegistry();
    registry.register(DoubleStrategy.method, DoubleStrategy);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "fanout-double",
      domain: "wardley",
      tool: "chain",
      steps: [
        { stepId: "double", tool: DoubleStrategy.method, over: "$.values", out: "$.results" },
      ],
      listeners: {},
    };

    const ast: Record<string, unknown> = { values: [1, 2, 3] };
    await runRecipe({ recipe, ast, context: ctx, registry });

    const results = ast.results as Array<{ result: number }>;
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.result), [2, 4, 6]);
  });

  it("emits step-start, step-end, and run-end events", async () => {
    const registry = new StrategyRegistry();
    registry.register(DoubleStrategy.method, DoubleStrategy);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "single-step",
      domain: "wardley",
      tool: "chain",
      steps: [{ stepId: "x", tool: DoubleStrategy.method, in: "$.v" }],
      listeners: {},
    };

    const ast: Record<string, unknown> = { v: 7 };
    const { events } = await runRecipe({ recipe, ast, context: ctx, registry });

    const phases = events.map((e) => e.phase);
    assert.deepEqual(phases, ["step-start", "step-end", "run-end"]);
  });

  it("emits step-error and run-end before rethrowing a failing step", async () => {
    const registry = new StrategyRegistry();
    registry.register(ThrowingStrategy.method, ThrowingStrategy);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "failing-step",
      domain: "wardley",
      tool: "chain",
      steps: [{ stepId: "boom", tool: ThrowingStrategy.method, in: "$.v" }],
      listeners: {},
    };

    const ast: Record<string, unknown> = { v: 7 };
    const busEvents: string[] = [];
    const { createEventBus } = await import("../bus/event-bus.mjs");
    const bus = createEventBus();
    const subscription = bus.observe().subscribe((event) => busEvents.push(event.phase));

    await assert.rejects(
      () => runRecipe({ recipe, ast, context: ctx, registry, bus }),
      /step boom/,
    );
    subscription.unsubscribe();

    assert.deepEqual(busEvents, ["step-start", "step-error", "run-end"]);
  });

  it("runs listeners after the main path and folds their insights into the envelope", async () => {
    const registry = new StrategyRegistry();
    registry.register(DoubleStrategy.method, DoubleStrategy);
    registry.register(InsightListener.method, InsightListener);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "double-with-listener",
      domain: "wardley",
      tool: "chain",
      steps: [{ stepId: "double", tool: DoubleStrategy.method, in: "$.value", out: "$.doubled" }],
      listeners: { double: [InsightListener.method] },
    };

    const ast: Record<string, unknown> = { value: 5 };
    const outcome = await runRecipe({ recipe, ast, context: ctx, registry });

    assert.equal((ast.doubled as { result: number }).result, 10);
    // The listener observed its parent step's business result ($.doubled.result = 10).
    const insight = outcome.envelope.insights.find((i) => i.by === InsightListener.method);
    assert.ok(insight, "listener insight should be in the envelope");
    assert.equal(insight?.text, "observed 10");
    // A trace entry is recorded for the listener, attributed to its parent step.
    assert.ok(
      outcome.envelope.trace.some(
        (t) => t.command === InsightListener.method && t.stepId === "double",
      ),
    );
  });

  it("isolates a failing listener — the main path still succeeds", async () => {
    const registry = new StrategyRegistry();
    registry.register(DoubleStrategy.method, DoubleStrategy);
    registry.register(ThrowingListener.method, ThrowingListener);
    registry.register(InsightListener.method, InsightListener);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "double-with-failing-listener",
      domain: "wardley",
      tool: "chain",
      steps: [{ stepId: "double", tool: DoubleStrategy.method, in: "$.value", out: "$.doubled" }],
      listeners: { double: [ThrowingListener.method, InsightListener.method] },
    };

    const ast: Record<string, unknown> = { value: 8 };
    const outcome = await runRecipe({ recipe, ast, context: ctx, registry });

    // Main path intact despite the throwing listener.
    assert.equal((ast.doubled as { result: number }).result, 16);
    // The surviving listener still contributed; the throwing one left no trace.
    assert.ok(
      outcome.envelope.insights.some(
        (i) => i.by === InsightListener.method && i.text === "observed 16",
      ),
    );
    assert.ok(!outcome.envelope.trace.some((t) => t.command === ThrowingListener.method));
  });

  it("puts the LLM usage aggregate in the run-end payload (CP9)", async () => {
    const registry = new StrategyRegistry();
    registry.register(UsageReportingStrategy.method, UsageReportingStrategy);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "usage-run",
      domain: "wardley",
      tool: "chain",
      steps: [{ stepId: "u", tool: UsageReportingStrategy.method, in: "$.v" }],
      listeners: {},
    };

    const ast: Record<string, unknown> = { v: 1 };
    const { events } = await runRecipe({ recipe, ast, context: ctx, registry });

    const runEnd = events.find((e) => e.phase === "run-end");
    const usage = (runEnd?.payload as { usage?: Record<string, number> })?.usage;
    assert.ok(usage, "run-end payload must carry usage");
    assert.equal(usage.llmCalls, 2);
    assert.equal(usage.inputTokens, 12);
    assert.equal(usage.outputTokens, 5);
  });

  it("builds the run-end quality map: numeric-only, collision last-wins (CP10)", async () => {
    const registry = new StrategyRegistry();
    registry.register(SignalEmittingStrategy.method, SignalEmittingStrategy);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "quality-run",
      domain: "wardley",
      tool: "chain",
      steps: [{ stepId: "s", tool: SignalEmittingStrategy.method, in: "$.v" }],
      listeners: {},
    };

    const ast: Record<string, unknown> = { v: 1 };
    const { events } = await runRecipe({ recipe, ast, context: ctx, registry });

    const runEnd = events.find((e) => e.phase === "run-end");
    const quality = (runEnd?.payload as { quality?: Record<string, number> })?.quality;
    assert.ok(quality, "run-end payload must carry quality");
    // Numeric-only: 'label' (string) is absent.
    assert.deepEqual(Object.keys(quality).sort(), ["confidence", "score"]);
    // Collision last-wins: 0.7 overwrote 0.9.
    assert.equal(quality.confidence, 0.7);
    assert.equal(quality.score, 42);
  });

  it("caps the quality map at 20 keys (CP10)", async () => {
    // A strategy emitting 25 distinct numeric signals; only the first 20 keys
    // may survive the cap.
    class ManySignalsStrategy extends BaseStrategy<number, number> {
      static get method(): string {
        return "wardley:chain:write:capacity:many";
      }
      async evaluate(input: number): Promise<StrategyResult<number>> {
        const at = new Date().toISOString();
        const signals = Array.from({ length: 25 }, (_v, i) => ({
          name: `m${i}`,
          value: i,
          source: "computed" as const,
          capturedAt: at,
        }));
        return { signals, reasoning: [], insights: [], result: input };
      }
    }
    const registry = new StrategyRegistry();
    registry.register(ManySignalsStrategy.method, ManySignalsStrategy);

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "many-run",
      domain: "wardley",
      tool: "chain",
      steps: [{ stepId: "m", tool: ManySignalsStrategy.method, in: "$.v" }],
      listeners: {},
    };

    const ast: Record<string, unknown> = { v: 1 };
    const { events } = await runRecipe({ recipe, ast, context: ctx, registry });
    const runEnd = events.find((e) => e.phase === "run-end");
    const quality = (runEnd?.payload as { quality?: Record<string, number> })?.quality;
    assert.ok(quality);
    assert.equal(Object.keys(quality).length, 20);
  });

  it("omits usage/quality from the payload when a run has neither (default path)", async () => {
    const registry = new StrategyRegistry();
    registry.register(SumStrategy.method, SumStrategy); // no signals, no usage

    const recipe: Recipe = {
      schemaVersion: "1.0",
      name: "plain-run",
      domain: "wardley",
      tool: "chain",
      steps: [{ stepId: "s", tool: SumStrategy.method, in: "$.v" }],
      listeners: {},
    };

    const ast: Record<string, unknown> = { v: 1 };
    const { events } = await runRecipe({ recipe, ast, context: ctx, registry });
    const runEnd = events.find((e) => e.phase === "run-end");
    const payload = runEnd?.payload as { usage?: unknown; quality?: unknown } | undefined;
    // llmCalls is always counted (0 calls here), so usage is present but with
    // llmCalls: 0 and no token sums; quality is absent (no numeric signals).
    assert.equal((payload?.usage as { llmCalls?: number })?.llmCalls, 0);
    assert.equal(payload?.quality, undefined);
  });
});
