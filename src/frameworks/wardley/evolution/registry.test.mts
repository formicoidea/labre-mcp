import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Side-effect import: registers prompt parsers used by LLMDirectStrategy.
import '#lib/prompts/init.mjs';
import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';
import { registerEvolutionStrategies } from './registry.mjs';
import { SCurveStrategy } from './_legacy/write/strategies/capacity/s-curve-strategy.mjs';
import { LLMDirectStrategy } from './_legacy/write/strategies/capacity/llm-direct-strategy.mjs';
import { PublicationAnalysisStrategy } from './_legacy/write/strategies/capacity/publication-analysis-strategy.mjs';
import { CpcEvolutionStrategyCore } from './_legacy/write/strategies/capacity/cpc-evolution-strategy.mjs';
import { TimelineBenchmarkStrategyCore } from './_legacy/write/strategies/capacity/timeline-benchmark-strategy.mjs';
import {
  LogprobDistributionStrategy,
  LogprobDistributionStrategyCore,
} from './_legacy/write/strategies/capacity/logprob-distribution-strategy.mjs';
import { PropertiesStrategyCore } from './_legacy/write/strategies/solution/properties-strategy.mjs';
import { IdentifyCapabilityStrategy } from '#frameworks/wardley/chain/_legacy/write/component/lib/capability/identify-capability.mjs';
import { EstimateAnchorEvolutionStrategy } from './_legacy/write/strategies/anchor/estimate-anchor-evolution.mjs';
import { phase4Distribution } from '#schemas/inputs.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { ComponentInput } from '#types/evolution.mjs';

const ctx: RequestContext = {
  projectId: 'p1',
  projectRoot: '/tmp/p1',
  sessionId: 's1',
  domain: 'wardley',
};

describe('evolution registry — SCurveStrategy', () => {
  it('registers SCurveStrategy under the 5-segment methodId', () => {
    const registry = new StrategyRegistry<BaseStrategy>();
    registerEvolutionStrategies(registry);
    assert.equal(registry.has('wardley:map:climate:position-functional-in-evolution:s-curve'), true);
    assert.equal(registry.has('wardley:map:climate:position-functional-in-evolution:llm-direct'), true);
    assert.equal(registry.has('wardley:map:climate:position-functional-in-evolution:publication-analysis'), true);
    assert.equal(registry.has('wardley:map:climate:position-functional-in-evolution:cpc-evolution'), true);
    assert.equal(registry.has('wardley:map:climate:position-functional-in-evolution:timeline-benchmark'), true);
    assert.equal(registry.has('wardley:map:climate:position-functional-in-evolution:logprob-distribution'), true);
    assert.equal(registry.has('wardley:map:climate:position-solution-in-evolution:property-assessment'), true);
    assert.equal(registry.has('wardley:map:node:identify:default'), true);
    assert.equal(registry.has('wardley:map:climate:position-anchor-in-evolution:default'), true);
    assert.equal(registry.has('wardley:map:climate:position-anchor-in-evolution:culture-phase'), true);
    assert.equal(registry.size(), 10);
  });

  it('CpcEvolutionStrategyCore.method returns the 5-segment id', () => {
    assert.equal(
      CpcEvolutionStrategyCore.method,
      'wardley:map:climate:position-functional-in-evolution:cpc-evolution',
    );
  });

  it('TimelineBenchmarkStrategyCore.method returns the 5-segment id', () => {
    assert.equal(
      TimelineBenchmarkStrategyCore.method,
      'wardley:map:climate:position-functional-in-evolution:timeline-benchmark',
    );
  });

  it('LogprobDistributionStrategyCore.method returns the 5-segment id', () => {
    assert.equal(
      LogprobDistributionStrategyCore.method,
      'wardley:map:climate:position-functional-in-evolution:logprob-distribution',
    );
  });

  it('SCurveStrategy.method returns the 5-segment id', () => {
    assert.equal(SCurveStrategy.method, 'wardley:map:climate:position-functional-in-evolution:s-curve');
  });

  it('SCurveStrategy.evaluate returns a valid StrategyResult shape', async () => {
    const strat = new SCurveStrategy();
    const input: ComponentInput = { name: 'X', certitude: 0.9, ubiquity: 0.85 };
    const out = await strat.evaluate(input, ctx);

    assert.ok(Array.isArray(out.signals));
    assert.ok(Array.isArray(out.reasoning));
    assert.ok(Array.isArray(out.insights));
    assert.equal(out.reasoning.length, 0, 'deterministic strategy has no LLM reasoning');
    assert.equal(out.insights.length, 0);
    assert.equal(out.signals.length, 3, 'certitude + ubiquity + confidence captured as signals');

    assert.equal(typeof out.result.evolution, 'number');
    assert.ok(out.result.evolution >= 0 && out.result.evolution <= 1);
    assert.equal(typeof out.result.confidence, 'number');
    assert.equal(out.result.method, 'wardley:map:climate:position-functional-in-evolution:s-curve');
  });

  it('SCurveStrategy.evaluate captures input signals with source = user-input', async () => {
    const strat = new SCurveStrategy();
    const out = await strat.evaluate(
      { name: 'X', certitude: 0.5, ubiquity: 0.5 },
      ctx,
    );
    const names = out.signals.map((s) => s.name).sort();
    assert.deepEqual(names, ['certitude', 'confidence', 'ubiquity']);
    // Input signals carry source = user-input; the computed confidence metric
    // (CP10) carries source = computed. All signals timestamp their capture.
    for (const sig of out.signals) {
      const expectedSource = sig.name === 'confidence' ? 'computed' : 'user-input';
      assert.equal(sig.source, expectedSource);
      assert.ok(sig.capturedAt.length > 0, 'capturedAt is ISO timestamp');
    }
    // The confidence signal is numeric so the run-level quality map can harvest it.
    const confSig = out.signals.find((s) => s.name === 'confidence');
    assert.ok(confSig);
    assert.equal(typeof confSig.value, 'number');
  });

  it('SCurveStrategy.evaluate throws when certitude/ubiquity missing', async () => {
    const strat = new SCurveStrategy();
    await assert.rejects(
      strat.evaluate({ name: 'X' } as ComponentInput, ctx),
      /requires certitude and ubiquity/,
    );
  });
});

describe('evolution registry — LLMDirectStrategy', () => {
  it('LLMDirectStrategy.method returns the 5-segment id', () => {
    assert.equal(LLMDirectStrategy.method, 'wardley:map:climate:position-functional-in-evolution:llm-direct');
  });

  it('LLMDirectStrategy.evaluate captures the raw LLM response in reasoning[0].text', async () => {
    const cannedResponse = 'Some chain of thought...\nevolution=0.65\nconfidence=0.78';
    // any: mock llmCall closure
    const llmCall: (user: string, ...args: unknown[]) => Promise<string> = async () => cannedResponse;
    const strat = new LLMDirectStrategy({ llmCall });
    const out = await strat.evaluate(
      { name: 'CRM', capability: 'manage customer relationships', context: 'B2B SaaS', date: 2025 },
      ctx,
    );
    assert.equal(out.reasoning.length, 1);
    assert.equal(out.reasoning[0].text, cannedResponse);
    assert.equal(out.reasoning[0].by, 'wardley:map:climate:position-functional-in-evolution:llm-direct');
    assert.ok(out.result.evolution >= 0 && out.result.evolution <= 1);
    assert.equal(out.result.method, 'wardley:map:climate:position-functional-in-evolution:llm-direct');
  });

  it('LLMDirectStrategy captures capability/date/context as user-input signals', async () => {
    // any: mock llmCall closure
    const llmCall: (user: string, ...args: unknown[]) => Promise<string> = async () => 'evolution=0.5\nconfidence=0.7';
    const strat = new LLMDirectStrategy({ llmCall });
    const out = await strat.evaluate(
      { name: 'X', capability: 'orchestration', context: 'cloud', date: '2025' },
      ctx,
    );
    const names = out.signals.map((s) => s.name).sort();
    assert.deepEqual(names, ['capability', 'context', 'date']);
    for (const sig of out.signals) {
      assert.equal(sig.source, 'user-input');
    }
  });
});

describe('evolution registry — timeline-benchmark is registered but refused', () => {
  // The strategy declares itself disabled: >30 min of LLM latency per run. It
  // stays in the catalogue — a caller asking for it deserves to be told why it
  // will not run, not a "no such strategy". Before CH-18 the flag lived only on
  // the legacy class, which the core registry never reads: the strategy was one
  // runCommand away from a half-hour run.
  it('resolution is refused, with the reason in the message', () => {
    const registry = new StrategyRegistry<BaseStrategy>();
    registerEvolutionStrategies(registry);
    assert.throws(
      () => registry.get('wardley:map:climate:position-functional-in-evolution:timeline-benchmark'),
      /is disabled: high LLM latency \(>30 min\/run\)/,
    );
  });

  it('but it stays listed, and its neighbours still resolve', () => {
    const registry = new StrategyRegistry<BaseStrategy>();
    registerEvolutionStrategies(registry);
    const id = 'wardley:map:climate:position-functional-in-evolution:timeline-benchmark';
    assert.equal(registry.has(id), true);
    assert.ok(registry.list().includes(id));
    assert.match(registry.disabledReason(id) ?? '', />30 min\/run/);
    // Exactly one strategy in this framework opts out.
    assert.deepEqual(registry.listDisabled().map((d) => d.methodId), [id]);
    // The sibling strategies are untouched.
    assert.equal(
      registry.get('wardley:map:climate:position-functional-in-evolution:s-curve'),
      SCurveStrategy,
    );
  });
});

describe('evolution registry — LogprobDistributionStrategy', () => {
  // Mock returning phase classification with logprobs; "Product" wins.
  const mockLogprobCall = async () => ({
    text: 'Product',
    logprobs: [
      { token: 'Product', logprob: -0.2 },
      { token: 'Commodity', logprob: -1.5 },
      { token: 'Custom', logprob: -2.8 },
      { token: 'Genesis', logprob: -4.0 },
    ],
  });

  it('computes a centroid in the product range from the logprobs', async () => {
    // any: mock logprob closure
    const strat = new LogprobDistributionStrategy({ llmLogprobCall: mockLogprobCall as any });
    const result = await strat.evaluate({
      name: 'Kubernetes',
      description: 'Container orchestration platform',
      context: 'cloud infrastructure',
    });
    assert.equal(typeof result.evolution, 'number');
    assert.ok(
      result.evolution > 0.3 && result.evolution < 0.7,
      `logprob evolution should land in the product range, got ${result.evolution}`,
    );
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    assert.equal(result.method, 'write:capacity:logprob-distribution');
  });

  it('requires an llmLogprobCall function', () => {
    assert.throws(() => new LogprobDistributionStrategy({}), /llmLogprobCall/i);
  });
});

describe('evolution registry — PublicationAnalysisStrategy', () => {
  it('PublicationAnalysisStrategy.method returns the 5-segment id', () => {
    assert.equal(
      PublicationAnalysisStrategy.method,
      'wardley:map:climate:position-functional-in-evolution:publication-analysis',
    );
  });

  it('uses provided phaseDistribution (no LLM call) and tags signal source = user-input', async () => {
    const strat = new PublicationAnalysisStrategy();
    const out = await strat.evaluate(
      {
        name: 'X',
        phaseDistribution: phase4Distribution(0.1, 0.2, 0.4, 0.3),
      } as ComponentInput,
      ctx,
    );
    assert.equal(out.reasoning.length, 0, 'no LLM was called');
    const distSig = out.signals.find((s) => s.name === 'distribution');
    assert.ok(distSig);
    assert.equal(distSig.source, 'user-input');
    assert.equal(out.result.method, 'wardley:map:climate:position-functional-in-evolution:publication-analysis');
    assert.ok(typeof out.result.evolution === 'number');
  });

  it('calls the LLM when no phaseDistribution provided and captures the response in reasoning', async () => {
    const canned = 'phase1=0.1\nphase2=0.2\nphase3=0.5\nphase4=0.2';
    // any: mock llmCall closure
    const llmCall: any = async () => canned;
    const strat = new PublicationAnalysisStrategy({ llmCall });
    const out = await strat.evaluate(
      { name: 'CRM', context: 'B2B SaaS' } as ComponentInput,
      ctx,
    );
    assert.equal(out.reasoning.length, 1);
    assert.equal(out.reasoning[0].text, canned);
    const distSig = out.signals.find((s) => s.name === 'distribution');
    assert.ok(distSig);
    assert.equal(distSig.source, 'llm-internal');
  });
});
