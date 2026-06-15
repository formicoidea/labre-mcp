import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecipe } from "./recipe-runner.mjs";
import { StrategyRegistry } from "../registry/strategy-registry.mjs";
import { BaseStrategy, type StrategyResult } from "../ast/base-strategy.mjs";
import type { Recipe } from "./recipe.schema.mjs";
import type { RequestContext } from "../context/request-context.mjs";

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
});
