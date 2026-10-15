// MCP tool `runBenchmarkScenario`: runs ONE labre strategy, as it is, on ONE
// benchmark case, with the model the caller names.
//
// Consumer: the wardley-evolution-benchmark, whose `labre-*` evaluators call it
// per case. The benchmark owns the cases, the reference values, the scoring and
// the storage; this tool only answers. It is stateless on purpose: no artefact
// under ~/.labre-mcp/runs (unlike runCommand), no reference value ever received.
//
// Usage is returned even when the strategy fails: the benchmark counts what a
// failing case spent. Like the recipe runner, it passes the hosted daemon's
// budget gate first and reports its calls to the cost ledger. That is why a strategy error is caught and reported as
// `{ ok: false, error }` instead of thrown — a throw would lose the usage
// collected before it. Input errors still throw (dispatch degrades them).

import { z } from "zod";
import type { ToolDefinition } from "#core/transport/mcp-handler.mjs";
import type { RequestContext } from "#core/context/request-context.mjs";
import { LLMDirectStrategy } from "#frameworks/wardley/evolution/_legacy/write/strategies/capacity/llm-direct-strategy.mjs";
import { PropertiesStrategyCore } from "#frameworks/wardley/evolution/_legacy/write/strategies/solution/properties-strategy.mjs";
import { getModelLLM } from "#lib/llm/registry.mjs";
import { assertQuotaOk } from "#lib/llm/quota-guard.mjs";
import { reportUsageToLedger } from "#lib/llm/ledger-report.mjs";
import { runWithUsageCollector, type LlmUsageAggregate } from "#lib/llm/usage-context.mjs";
import { validateOrThrow } from "#lib/zod/validate-or-throw.mjs";
import type { LLMCall } from "#types/llm.mjs";

// ponytail: two scenarios. labre's s-curve strategy takes certitude/ubiquity
// from its caller and never asks a model for them, so the benchmark's
// certitude-ubiquity-scurve (a promptfoo prompt) has no labre strategy to run.
type Component = { name: string; context?: string; description?: string };
const SCENARIOS = {
  // any: LLMDirectStrategy types its call as `(user, ...unknown[])`, a wider
  // signature than LLMCall; the strategy only ever passes LLMCall's arguments.
  "llm-direct": (llmCall: LLMCall, c: Component, context: RequestContext) =>
    new LLMDirectStrategy({ llmCall: llmCall as (user: string, ...args: unknown[]) => Promise<string> })
      .evaluate({ kind: "capability", ...c }, context),
  "property-assessment": (llmCall: LLMCall, c: Component, context: RequestContext) =>
    new PropertiesStrategyCore({ llmCall, mode: "auto" }).evaluate({ kind: "solution", ...c }, context),
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
  /** What makes a bad answer explainable: the raw reply (llm-direct), the
   *  per-property phases and the evaluated/total count in `trace`
   *  (property-assessment, whose back-filled rows read "Not evaluated…"). */
  details?: { reasoning: unknown[]; insights: unknown[]; properties?: unknown[]; trace?: unknown[] };
  error?: string;
  usage: LlmUsageAggregate;
  durationMs: number;
}

export async function runBenchmarkScenario(
  args: unknown,
  context: RequestContext,
): Promise<RunBenchmarkScenarioResult> {
  const input = validateOrThrow(RunBenchmarkScenarioInputSchema, args, "runBenchmarkScenario input");
  const llmCall = getModelLLM(input.provider, input.model);
  // Budget gate (ADR-0032 Decision 2), as the recipe runner: this tool spends
  // labre's key on the hosted daemon. No-op without a caller JWT.
  await assertQuotaOk();
  const started = Date.now();
  let usage: LlmUsageAggregate = { llmCalls: 0, records: [] };
  try {
    const out = await runWithUsageCollector(
      () => SCENARIOS[input.scenario](llmCall, input.component, context),
      (aggregate) => {
        usage = aggregate;
        // Cost ledger (ADR-0032 Decision 3), as the recipe runner: fire-and-forget, never throws.
        void reportUsageToLedger(aggregate.records);
      },
    );
    const { evolution, confidence, method, trace } = out.result;
    const properties = "properties" in out.result && Array.isArray(out.result.properties)
      ? out.result.properties
      : undefined;
    return {
      ok: true,
      scenario: input.scenario,
      method,
      evolution,
      confidence,
      details: { reasoning: out.reasoning, insights: out.insights, ...(properties ? { properties } : {}), ...(trace ? { trace } : {}) },
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

/** Who may call the tool. It spends labre's key on a model the CALLER names, so
 *  on the hosted daemon it is closed to every authenticated caller but the
 *  user ids listed at boot (LABRE_BENCHMARK_USERS). An unauthenticated context
 *  (stdio, local dev without LABRE_AUTH) passes: it is the operator's own. */
export function parseBenchmarkUsers(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function createRunBenchmarkScenarioTool(allowedUsers: Set<string>): ToolDefinition {
  return {
    name: "runBenchmarkScenario",
    description:
      "Run one labre evolution strategy, unchanged, on one benchmark case with the model the caller names. " +
      "Returns the position, the strategy's details and the metered LLM usage (also on failure). Writes nothing. " +
      "Restricted to the user ids of LABRE_BENCHMARK_USERS on an authenticated daemon.",
    // any: zod-to-json conversion — the schema is well-typed at the Zod layer
    inputSchema: z.toJSONSchema(RunBenchmarkScenarioInputSchema, { io: "input" }) as Record<string, unknown>,
    async handler(args, context) {
      if (context.auth && !allowedUsers.has(context.auth.userId)) {
        throw new Error("runBenchmarkScenario is not open to this account");
      }
      return runBenchmarkScenario(args, context);
    },
  };
}
