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
      listeners: [],
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
      listeners: [],
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
      listeners: [],
    };

    const ast: Record<string, unknown> = { v: 7 };
    const { events } = await runRecipe({ recipe, ast, context: ctx, registry });

    const phases = events.map((e) => e.phase);
    assert.deepEqual(phases, ["step-start", "step-end", "run-end"]);
  });
});
