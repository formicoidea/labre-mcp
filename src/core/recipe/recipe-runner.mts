// Recipe runner: executes a Recipe against an initial AST, producing a final
// AST and an event trace. Steps run sequentially; an individual step with
// `over` fans out across the matching array elements with Promise.allSettled
// (per memory feedback_parallelize_independent.md).
//
// Each step emits step-start and step-end events on the bus. Listeners (per
// recipe.listeners) attach at run start and detach at run end. The runner
// returns the modified AST and a reference to the (drained) event bus.

import { randomUUID } from "node:crypto";
import { readPath, writePath } from "./jsonpath-fanout.mjs";
import type { Recipe, RecipeStep } from "./recipe.schema.mjs";
import type { StrategyRegistry } from "../registry/strategy-registry.mjs";
import type { BaseStrategy, StrategyResult } from "../ast/base-strategy.mjs";
import type { RequestContext } from "../context/request-context.mjs";
import { createEventBus, type EventBus } from "../bus/event-bus.mjs";
import type { PipelineEvent } from "../bus/event.schema.mjs";

export interface RunOptions {
  recipe: Recipe;
  ast: Record<string, unknown>;
  context: RequestContext;
  registry: StrategyRegistry;
  // Optional pre-existing bus (e.g. for tests) — otherwise one is created.
  bus?: EventBus;
}

export interface RunOutcome {
  recipeRunId: string;
  ast: Record<string, unknown>;
  events: PipelineEvent[];
  bus: EventBus;
}

export async function runRecipe(options: RunOptions): Promise<RunOutcome> {
  const recipeRunId = randomUUID();
  const bus = options.bus ?? createEventBus();

  // Capture every event into a flat trace so the caller (and the artefact
  // writer listener in CP8) can serialise them in run order.
  const events: PipelineEvent[] = [];
  const subscription = bus.observe().subscribe((e) => {
    events.push(e);
  });

  try {
    for (const step of options.recipe.steps) {
      await executeStep({
        step,
        ast: options.ast,
        context: options.context,
        registry: options.registry,
        bus,
        recipeRunId,
        sessionId: options.context.sessionId,
      });
    }

    bus.emit({
      schemaVersion: "1.0",
      recipeRunId,
      sessionId: options.context.sessionId,
      stepId: "__run__",
      // The run-end event needs a methodId that respects the 5-segment
      // grammar (ast-schema.md v0.1.0). The recipe name itself is already
      // carried by recipeRunId; this synthetic id only identifies the event
      // origin as "the recipe runner of this domain".
      methodId: `${options.recipe.domain}:recipe:orchestration:run:default`,
      phase: "run-end",
      timestamp: new Date().toISOString(),
    });
  } finally {
    subscription.unsubscribe();
  }

  return { recipeRunId, ast: options.ast, events, bus };
}

interface StepExecutionContext {
  step: RecipeStep;
  ast: Record<string, unknown>;
  context: RequestContext;
  registry: StrategyRegistry;
  bus: EventBus;
  recipeRunId: string;
  sessionId: string;
}

async function executeStep(ctx: StepExecutionContext): Promise<void> {
  const { step, ast, context, registry, bus, recipeRunId, sessionId } = ctx;

  const strategyClass = registry.get(step.tool);
  // any: strategy constructor signature is open by design; framework code is responsible for arg shape
  const strategy = new (strategyClass as unknown as new () => BaseStrategy)();

  const inputPath = step.in ?? "$";
  const outputPath = step.out ?? "$.lastResult";

  const startedAt = Date.now();
  bus.emit({
    schemaVersion: "1.0",
    recipeRunId,
    sessionId,
    stepId: step.stepId,
    methodId: step.tool,
    phase: "step-start",
    timestamp: new Date(startedAt).toISOString(),
  });

  let result: unknown;
  if (step.over) {
    // Auto-fanout: run the strategy once per element in the array at `over`.
    const items = readPath(ast, step.over);
    if (!Array.isArray(items)) {
      throw new Error(
        `Step "${step.stepId}" has 'over: ${step.over}' but the path did not resolve to an array (got ${typeof items})`,
      );
    }
    const settled = await Promise.allSettled(
      items.map((item) => strategy.evaluate(item, context)),
    );
    result = settled.map((s) =>
      s.status === "fulfilled" ? s.value : { error: String(s.reason) },
    );
  } else {
    const input = readPath(ast, inputPath);
    result = await strategy.evaluate(input, context);
  }

  writePath(ast, outputPath, result);

  const completedAt = Date.now();
  bus.emit({
    schemaVersion: "1.0",
    recipeRunId,
    sessionId,
    stepId: step.stepId,
    methodId: step.tool,
    phase: "step-end",
    timestamp: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    payload: summariseResult(result),
  });
}

// Keep the bus payload light — full results live on the AST. The summary
// captures shape so cross-step listeners can reason without the full body.
function summariseResult(result: unknown): unknown {
  if (Array.isArray(result)) {
    return { kind: "array", length: result.length };
  }
  if (result && typeof result === "object") {
    const r = result as StrategyResult;
    if ("result" in r) {
      return {
        kind: "strategy-result",
        signalsCount: r.signals?.length ?? 0,
        reasoningCount: r.reasoning?.length ?? 0,
        insightsCount: r.insights?.length ?? 0,
      };
    }
    return { kind: "object", keys: Object.keys(result as Record<string, unknown>).length };
  }
  return { kind: typeof result };
}
