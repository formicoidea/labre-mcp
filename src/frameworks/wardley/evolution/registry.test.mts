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
import { LogprobDistributionStrategyCore } from './_legacy/write/strategies/capacity/logprob-distribution-strategy.mjs';
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
    assert.equal(registry.has('wardley:evolution:write:solution:properties'), true);
    assert.equal(registry.has('wardley:evolution:read:component:identify-capability'), true);
    assert.equal(registry.has('wardley:evolution:write:anchor:culture-phase'), true);
    assert.equal(registry.size(), 9);
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
    assert.equal(out.signals.length, 2, 'certitude + ubiquity captured as signals');

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
    assert.deepEqual(names, ['certitude', 'ubiquity']);
    for (const sig of out.signals) {
      assert.equal(sig.source, 'user-input');
      assert.ok(sig.capturedAt.length > 0, 'capturedAt is ISO timestamp');
    }
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
