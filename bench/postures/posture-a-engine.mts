// Posture A — THE ENGINE.
//
// The real placement strategy of the real registry, resolved by its 5-segment
// methodId exactly as `runCommand` resolves it, and invoked in-process (the
// lib path — no daemon, no HTTP, no MCP envelope). Nothing here is a
// re-implementation: `registerEvolutionStrategies` is the framework's own
// registration function, and the class it hands back is the shipped one.
//
// The LLM call is INJECTED through the strategy's own constructor seam
// (`new LLMDirectStrategy({ llmCall })`), which is what makes the three arms
// share one provider, one model and one temperature. Without that, the bench
// would be comparing providers, not postures.

// Boot side-effect, exactly as `boot-tool-registry.mts` does it: the engine's
// prompts declare their response parsers by id in `prompts.config.json`, and
// `getPrompt(...).parse()` throws until those ids are registered. Without this
// import posture A — the incumbent — fails every case with "parser 'llmDirect'
// is not registered", and the falsification test measures nothing.
import '#lib/prompts/init.mjs';

import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';
import { registerEvolutionStrategies } from '#frameworks/wardley/evolution/registry.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { ComponentInput, EvolutionResult } from '#types/evolution.mjs';
import type { StrategyResult } from '#core/ast/base-strategy.mjs';
import type { GoldCase, Posture, PostureAnswer, PostureDeps } from '../bench.types.mjs';

/** The placement strategy under test — the one `estimateEvolution` reaches. */
export const ENGINE_METHOD_ID =
  'wardley:map:climate:position-functional-in-evolution:llm-direct';

/** Build the engine registry the way the daemon boot does, minus the daemon. */
export function createEvolutionRegistry(): StrategyRegistry<BaseStrategy> {
  const registry = new StrategyRegistry<BaseStrategy>();
  registerEvolutionStrategies(registry);
  return registry;
}

/** The engine's typed input, built from the shared case payload. */
export function toComponentInput(goldCase: GoldCase): ComponentInput {
  return {
    kind: 'capability',
    name: goldCase.component,
    description: goldCase.description,
    context: goldCase.context,
    date: goldCase.date,
  };
}

export const postureA: Posture = {
  id: 'A',
  label: 'Moteur — stratégie du registre (llm-direct)',
  llmCallsPerCase: 1,

  async run(goldCase: GoldCase, deps: PostureDeps): Promise<PostureAnswer> {
    const registry = createEvolutionRegistry();
    const StrategyClass = registry.get(ENGINE_METHOD_ID);
    const strategy = new StrategyClass({ llmCall: deps.llmCall });

    const context: RequestContext = {
      projectId: 'bench-ch27',
      projectRoot: process.cwd(),
      sessionId: 'bench-posture-a',
      domain: 'wardley',
    };

    // any: the registry is structurally typed over BaseStrategy; this strategy's
    // concrete input/output pair is known at this call site and nowhere else.
    const result = (await strategy.evaluate(
      toComponentInput(goldCase) as never,
      context,
    )) as StrategyResult<EvolutionResult>;

    return {
      evolution: result.result.evolution,
      confidence: result.result.confidence,
      rationale: result.reasoning.map((r) => r.text).join('\n\n'),
      trace: {
        llmCalls: [],
        // ARCH-22: the strategy contract itself is the structured trace —
        // typed signals with their source, attributed reasoning, insights.
        structured: {
          methodId: ENGINE_METHOD_ID,
          signals: result.signals,
          reasoning: result.reasoning,
          insights: result.insights,
          result: result.result,
        },
        deterministic: null,
      },
    };
  },
};
