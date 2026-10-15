// MCP tool `runBenchmarkScenario`: runs ONE labre strategy, as it is, on ONE
// benchmark case, with the model the caller names.
//
// Consumer: the wardley-evolution-benchmark, whose `labre-*` evaluators call it
// per case. The benchmark owns the cases, the reference values, the scoring and
// the storage; this tool only answers. It is stateless on purpose: no artefact
// under ~/.labre-mcp/runs (unlike runCommand), no reference value ever received.
//
// Usage is returned even when the strategy fails: the benchmark counts what a
// failing case spent. That is why a strategy error is caught and reported as
// `{ ok: false, error }` instead of thrown — a throw would lose the usage
// collected before it. Input errors still throw (dispatch degrades them).

import { z } from "zod";
import type { ToolDefinition } from "#core/transport/mcp-handler.mjs";
import type { RequestContext } from "#core/context/request-context.mjs";
import { LLMDirectStrategy } from "#frameworks/wardley/evolution/_legacy/write/strategies/capacity/llm-direct-strategy.mjs";
import { PropertiesStrategyCore } from "#frameworks/wardley/evolution/_legacy/write/strategies/solution/properties-strategy.mjs";
import { getModelLLM } from "#lib/llm/registry.mjs";
import { runWithUsageCollector, type LlmUsageAggregate } from "#lib/llm/usage-context.mjs";
import { validateOrThrow } from "#lib/zod/validate-or-throw.mjs";
import type { LLMCall } from "#types/llm.mjs";

// ponytail: two scenarios. labre's s-curve strategy takes certitude/ubiquity
// from its caller and never asks a model for them, so the benchmark's
// certitude-ubiquity-scurve (a promptfoo prompt) has no labre strategy to run.
const SCENARIOS = {
  // any: LLMDirectStrategy types its call as `(user, ...unknown[])`, a wider
  // signature than LLMCall; the strategy only ever passes LLMCall's arguments.
  "llm-direct": (llmCall: LLMCall) =>
    new LLMDirectStrategy({ llmCall: llmCall as (user: string, ...args: unknown[]) => Promise<string> }),
  "property-assessment": (llmCall: LLMCall) => new PropertiesStrategyCore({ llmCall, mode: "auto" }),
} as const;

export const RunBenchmarkScenarioInputSchema = z.object({
  scenario: z.enum(Object.keys(SCENARIOS) as [keyof typeof SCENARIOS, ...(keyof typeof SCENARIOS)[]])
    .describe("The labre strategy to run, as it is."),
  provider: z.string().min(1).describe("A provider id declared in the daemon's llm.config.json."),
  model: z.string().min(1).describe("The model to call on that provider."),
  component: z.object({
    name: z.string().min(1).max(200),
    context: z.string().max(300).optional().describe("The sector the case is judged in."),
    description: z.string().max(20_000).optional().describe("The evidence of the case."),
  }).strict().describe("The case, without its reference value."),
}).strict();
export type RunBenchmarkScenarioInput = z.infer<typeof RunBenchmarkScenarioInputSchema>;

export interface RunBenchmarkScenarioResult {
  ok: boolean;
  scenario: string;
  method?: string;
  evolution?: number;
  confidence?: number;
  /** What makes a bad answer explainable: raw reply, per-property phases. */
  details?: { reasoning: unknown[]; insights: unknown[]; properties?: unknown[] };
  error?: string;
  usage: LlmUsageAggregate;
  durationMs: number;
}

export async function runBenchmarkScenario(
  args: unknown,
  context: RequestContext,
): Promise<RunBenchmarkScenarioResult> {
  const input = validateOrThrow(RunBenchmarkScenarioInputSchema, args, "runBenchmarkScenario input");
  const strategy = SCENARIOS[input.scenario](getModelLLM(input.provider, input.model));
  const kind = input.scenario === "property-assessment" ? "solution" : "capability";
  const started = Date.now();
  let usage: LlmUsageAggregate = { llmCalls: 0, records: [] };
  try {
    const out = await runWithUsageCollector(
      // any: the two strategies take their own input union member; `kind` picks it
      () => strategy.evaluate({ kind, ...input.component } as never, context),
      (aggregate) => { usage = aggregate; },
    );
    const { evolution, confidence, method } = out.result;
    const properties = "properties" in out.result && Array.isArray(out.result.properties)
      ? out.result.properties
      : undefined;
    return {
      ok: true,
      scenario: input.scenario,
      method,
      evolution,
      confidence,
      details: { reasoning: out.reasoning, insights: out.insights, ...(properties ? { properties } : {}) },
      usage,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      scenario: input.scenario,
      error: err instanceof Error ? err.message : String(err),
      usage,
      durationMs: Date.now() - started,
    };
  }
}

export const RUN_BENCHMARK_SCENARIO_TOOL: ToolDefinition = {
  name: "runBenchmarkScenario",
  description:
    "Run one labre evolution strategy, unchanged, on one benchmark case with the model the caller names. " +
    "Returns the position, the strategy's details and the metered LLM usage (also on failure). Writes nothing.",
  // any: zod-to-json conversion — the schema is well-typed at the Zod layer
  inputSchema: z.toJSONSchema(RunBenchmarkScenarioInputSchema, { io: "input" }) as Record<string, unknown>,
  handler: runBenchmarkScenario,
};
