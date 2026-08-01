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
import {
  runWithPromptOverrides,
  type PromptOverrideStore,
} from "#lib/prompts/override-context.mjs";
import {
  runWithUsageCollector,
  type LlmUsageAggregate,
} from "#lib/llm/usage-context.mjs";
import { reportUsageToLedger } from "#lib/llm/ledger-report.mjs";
import { assertQuotaOk } from "#lib/llm/quota-guard.mjs";

export interface RunOptions {
  recipe: Recipe;
  ast: Record<string, unknown>;
  context: RequestContext;
  registry: StrategyRegistry;
  // Optional pre-existing bus (e.g. for tests) — otherwise one is created.
  bus?: EventBus;
  // Optional run-scoped prompt overrides (bundle A/B testing). When present,
  // the whole step-execution phase runs inside runWithPromptOverrides so every
  // step's getPrompt() sees the bundle's prompts; absent → default path,
  // byte-identical to a run without overrides.
  promptOverrides?: PromptOverrideStore["prompts"];
  // Optional run-scoped variant assignment (prompt experiments): strategyId →
  // selected variant name. When present, every step's getPrompt('default')
  // redirects to the assigned variant. Independent of promptOverrides — either
  // (or both) triggers the ALS wrap below.
  activeVariants?: PromptOverrideStore["activeVariants"];
}

// JSON-labre envelope shape (ast-schema.md v0.1.0 § 2.0).
// The runner aggregates signals/reasoning/insights from every step's
// StrategyResult into a single envelope returned alongside the AST.
// The wardley.* sub-trees of JSON-labre are assembled by the caller from
// the AST keys it owns; the envelope is runner-managed.
export interface JsonLabreEnvelope {
  context: Record<string, unknown>;
  signals: StrategyResult["signals"];
  reasoning: StrategyResult["reasoning"];
  insights: StrategyResult["insights"];
  trace: Array<{
    command: string;
    stepId: string;
    durationMs?: number;
    startedAt: string;
    completedAt: string;
  }>;
  references: Array<{ artifactPath: string; jsonPath?: string }>;
}

export interface RunOutcome {
  recipeRunId: string;
  ast: Record<string, unknown>;
  events: PipelineEvent[];
  bus: EventBus;
  envelope: JsonLabreEnvelope;
}

export async function runRecipe(options: RunOptions): Promise<RunOutcome> {
  const recipeRunId = randomUUID();
  const bus = options.bus ?? createEventBus();

  // Capture every event into a flat trace so the caller (and the artefact
  // writer listener) can serialise them in run order.
  const events: PipelineEvent[] = [];
  const subscription = bus.observe().subscribe((e) => {
    events.push(e);
  });

  // Runner-level envelope accumulator (ast-schema.md v0.1.0 § 2.0).
  const envelope: JsonLabreEnvelope = {
    context: {},
    signals: [],
    reasoning: [],
    insights: [],
    trace: [],
    references: [],
  };

  // Run-level LLM usage aggregate (CP9), populated by the ALS collector that
  // wraps the run body. Undefined until the collector's onAggregate fires
  // (i.e. after the run body completes). Metadata/numbers only — no content.
  let usage: LlmUsageAggregate | undefined;

  let runEndEmitted = false;
  const emitRunEnd = () => {
    if (runEndEmitted) return;
    runEndEmitted = true;
    // Assemble the run-end payload from run-level performance signals: LLM usage
    // (CP9) and numeric quality metrics harvested from the envelope (CP10). The
    // payload stays metadata/numbers only — the telemetry listener forwards
    // these to PostHog, so no prompt text or model output may enter here.
    const quality = buildQualityMap(envelope.signals);
    const payload: { usage?: LlmUsageAggregate; quality?: Record<string, number> } = {};
    if (usage !== undefined) payload.usage = usage;
    if (Object.keys(quality).length > 0) payload.quality = quality;
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
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    });
  };

  // The whole run loop (steps + listeners). Wrapped in the run-scoped prompt
  // override store when the caller supplies overrides, so every getPrompt()
  // reachable from a step/listener sees the bundle's prompts for this run only.
  const runBody = async (): Promise<void> => {
    for (const step of options.recipe.steps) {
      await executeStep({
        step,
        ast: options.ast,
        context: options.context,
        registry: options.registry,
        bus,
        recipeRunId,
        sessionId: options.context.sessionId,
        envelope,
      });
    }

    // Listeners (ARCH-10, opt-in): run AFTER the whole main path completes,
    // all in parallel. Each listener observes its parent step by reading that
    // step's business result from the AST. They only contribute to the
    // envelope; a listener failure is isolated and never affects the main path
    // or the returned AST. Placed before the run-end event so the envelope is
    // complete when the artefact writer serialises the run.
    await runListeners({
      recipe: options.recipe,
      ast: options.ast,
      context: options.context,
      registry: options.registry,
      envelope,
    });
  };

  // Compose the prompt-override wrap (A/B testing) with the usage collector
  // (CP9). Order is irrelevant — the collector only needs to enclose every LLM
  // call, and the override store only needs to enclose every getPrompt(); both
  // sit above the same step-execution tree. The collector always wraps the run
  // (its overhead is a single ALS frame); the override wrap stays conditional so
  // the default path is byte-identical to a run with no A/B involvement.
  const runWithOverrides = async (): Promise<void> => {
    const hasPrompts = options.promptOverrides !== undefined
      && Object.keys(options.promptOverrides).length > 0;
    const hasVariants = options.activeVariants !== undefined
      && Object.keys(options.activeVariants).length > 0;
    if (hasPrompts || hasVariants) {
      await runWithPromptOverrides(
        { prompts: options.promptOverrides ?? {}, activeVariants: options.activeVariants },
        runBody,
      );
    } else {
      await runBody();
    }
  };

  // Budget gate (ADR-0032 Decision 2), BEFORE any step runs: on the hosted
  // daemon the LLM calls below spend labre's own key, so a caller whose labre
  // AI budget is exhausted is refused here rather than after the money is gone.
  // A no-op off the hosted daemon (no caller JWT) and fail-open on any doubt.
  // Outside the try/finally on purpose: nothing has started, so there is no
  // run-end to emit and no subscription to unwind.
  await assertQuotaOk();

  try {
    await runWithUsageCollector(runWithOverrides, (aggregate) => {
      usage = aggregate;
      // Report this run's spend to labre's cost ledger (ADR-0032 Decision 3).
      // Fire-and-forget: a no-op unless a caller JWT is in scope (the hosted
      // daemon), and best-effort inside — it never throws and never blocks the
      // run's return. Not awaited: the aggregate callback is synchronous and the
      // run must not wait on a metering write.
      void reportUsageToLedger(aggregate.records);
    });
    emitRunEnd();
  } catch (err) {
    emitRunEnd();
    throw err;
  } finally {
    subscription.unsubscribe();
  }

  return { recipeRunId, ast: options.ast, events, bus, envelope };
}

export interface RunCommandOptions {
  command: string; // 5-segment methodId
  // any: input shape is command-specific — passed verbatim to the strategy
  input: unknown;
  context: RequestContext;
  registry: StrategyRegistry;
  bus?: EventBus;
  // Optional caller-owned AST object. Pass it when an artefact-writer listener
  // attached to the same bus needs the live AST reference (it is mutated in
  // place and read at run-end). The command's input is seeded at `$.input`.
  ast?: Record<string, unknown>;
}

// Run a single command (methodId) directly and get a JSON-labre envelope back.
//
// A command is modelled as a degenerate 1-step recipe so the exact same
// machinery applies — envelope assembly, step/run events, and (via the
// caller-attached listener) artefact persistence. This is what makes a
// stand-alone command call equivalent to a recipe step: its result carries an
// envelope just like a recipe run does.
//
// The strategy receives `input` (seeded at `$.input`); its StrategyResult is
// written to `$.result` on the returned `outcome.ast`. `domain`/`tool` for the
// synthetic recipe derive from the command's first two segments so the
// run-end event keeps a valid 5-segment methodId.
export async function runCommand(options: RunCommandOptions): Promise<RunOutcome> {
  const [domain = 'common', tool = 'command'] = options.command.split('@')[0].split(':');
  const recipe: Recipe = {
    schemaVersion: '1.0',
    name: options.command,
    domain,
    tool,
    steps: [{ stepId: 'command', tool: options.command, in: '$.input', out: '$.result' }],
    listeners: {},
  };
  const ast: Record<string, unknown> = options.ast ?? {};
  ast.input = options.input;
  return runRecipe({
    recipe,
    ast,
    context: options.context,
    registry: options.registry,
    bus: options.bus,
  });
}

interface StepExecutionContext {
  step: RecipeStep;
  ast: Record<string, unknown>;
  context: RequestContext;
  registry: StrategyRegistry;
  bus: EventBus;
  recipeRunId: string;
  sessionId: string;
  envelope: JsonLabreEnvelope;
}

async function executeStep(ctx: StepExecutionContext): Promise<void> {
  const { step, ast, context, registry, bus, recipeRunId, sessionId, envelope } = ctx;

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
    try {
      const settled = await Promise.allSettled(
        items.map((item) => strategy.evaluate(item, context)),
      );
      result = settled.map((s) =>
        s.status === "fulfilled" ? s.value : { error: String(s.reason) },
      );
    } catch (err) {
      emitStepError({ bus, recipeRunId, sessionId, step, startedAt, err });
      throw err;
    }
  } else {
    const input = readPath(ast, inputPath);
    try {
      result = await strategy.evaluate(input, context);
    } catch (err) {
      emitStepError({ bus, recipeRunId, sessionId, step, startedAt, err });
      throw err;
    }
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

  // Aggregate this step's StrategyResult into the run-level envelope.
  // For fanout steps (step.over), each item is its own StrategyResult; for
  // non-fanout steps the single result is collected.
  if (Array.isArray(result)) {
    for (const item of result) collectEnvelope(envelope, item);
  } else {
    collectEnvelope(envelope, result);
  }
  envelope.trace.push({
    command: step.tool,
    stepId: step.stepId,
    durationMs: completedAt - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
  });
}

function emitStepError(args: {
  bus: EventBus;
  recipeRunId: string;
  sessionId: string;
  step: RecipeStep;
  startedAt: number;
  err: unknown;
}): void {
  const completedAt = Date.now();
  args.bus.emit({
    schemaVersion: "1.0",
    recipeRunId: args.recipeRunId,
    sessionId: args.sessionId,
    stepId: args.step.stepId,
    methodId: args.step.tool,
    phase: "step-error",
    timestamp: new Date(completedAt).toISOString(),
    durationMs: completedAt - args.startedAt,
    payload: { error: (args.err as Error)?.message ?? String(args.err) },
  });
}

// Fold a StrategyResult's analytical channels (signals/reasoning/insights)
// into the run-level envelope (ARCH-22). Shared by main-path steps and
// opt-in listeners. Non-StrategyResult values are ignored.
function collectEnvelope(envelope: JsonLabreEnvelope, sr: unknown): void {
  if (!sr || typeof sr !== "object") return;
  const r = sr as Partial<StrategyResult>;
  if (Array.isArray(r.signals))   envelope.signals.push(...r.signals);
  if (Array.isArray(r.reasoning)) envelope.reasoning.push(...r.reasoning);
  if (Array.isArray(r.insights))  envelope.insights.push(...r.insights);
}

// Cap on the number of quality metrics forwarded per run (CP10). Guards the
// telemetry payload (and PostHog property count) against an unbounded set of
// numeric signals; once reached we simply stop adding more.
const MAX_QUALITY_KEYS = 20;

// Build the run-level quality map (CP10) from the envelope's accumulated
// signals. A signal contributes iff its `value` is a finite number; the entry
// keyed by the signal's `name` takes that number. Collisions resolve last-wins
// (later signals overwrite earlier ones with the same name). Adds stop once
// MAX_QUALITY_KEYS distinct keys exist — an update to an existing key is always
// allowed (it does not grow the key set). Numbers only: string/object signal
// values are ignored, keeping the downstream telemetry privacy-safe.
function buildQualityMap(
  signals: JsonLabreEnvelope["signals"],
): Record<string, number> {
  const quality: Record<string, number> = {};
  for (const signal of signals) {
    if (typeof signal.value !== "number" || !Number.isFinite(signal.value)) continue;
    const isNewKey = !(signal.name in quality);
    if (isNewKey && Object.keys(quality).length >= MAX_QUALITY_KEYS) continue; // cap: stop adding new keys
    quality[signal.name] = signal.value;
  }
  return quality;
}

interface ListenerInvocation {
  parentStepId: string;
  methodId: string;
  parentOut: string;
}

// Execute every opt-in listener declared on the recipe, AFTER the main path,
// all in parallel (hard rule #15). A listener observes its parent step by
// reading that step's business result from the AST (`<step.out>.result`,
// symmetric with how downstream steps consume `$.x.result`). Listeners only
// contribute to the envelope (signals/reasoning/insights + a trace entry);
// a listener failure is isolated (Promise.allSettled) and never affects the
// main path or the returned AST (ARCH-10).
async function runListeners(opts: {
  recipe: Recipe;
  ast: Record<string, unknown>;
  context: RequestContext;
  registry: StrategyRegistry;
  envelope: JsonLabreEnvelope;
}): Promise<void> {
  const { recipe, ast, context, registry, envelope } = opts;

  const outByStep = new Map(recipe.steps.map((s) => [s.stepId, s.out ?? "$.lastResult"]));
  const invocations: ListenerInvocation[] = [];
  for (const [parentStepId, methodIds] of Object.entries(recipe.listeners)) {
    const parentOut = outByStep.get(parentStepId);
    if (!parentOut) continue; // schema guarantees the stepId exists; defensive
    for (const methodId of methodIds) {
      invocations.push({ parentStepId, methodId, parentOut });
    }
  }
  if (invocations.length === 0) return;

  const settled = await Promise.allSettled(
    invocations.map(async (inv) => {
      const startedAt = Date.now();
      const strategyClass = registry.get(inv.methodId);
      // any: strategy constructor signature is open by design (mirrors executeStep)
      const strategy = new (strategyClass as unknown as new () => BaseStrategy)();
      const parentResult = readPath(ast, `${inv.parentOut}.result`);
      const result = await strategy.evaluate(parentResult, context);
      return { inv, result, startedAt, completedAt: Date.now() };
    }),
  );

  for (const s of settled) {
    if (s.status !== "fulfilled") continue; // isolation: failure never affects the run
    const { inv, result, startedAt, completedAt } = s.value;
    collectEnvelope(envelope, result);
    envelope.trace.push({
      command: inv.methodId,
      stepId: inv.parentStepId,
      durationMs: completedAt - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
    });
  }
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
