// Would have caught: three silent fallbacks answering under this strategy's
// name — no logprobs (text fallback 0.85 / 0.05), no phase token (uniform),
// and a token matching every phase (uniform again, ≈ 0.43 on every component).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '#lib/prompts/init.mjs';
import { LogprobDistributionStrategy, extractPhaseProbabilities } from './logprob-distribution-strategy.mjs';

const strategy = (logprobs: { token: string; logprob: number }[]) =>
  new LogprobDistributionStrategy({ llmLogprobCall: async () => ({ text: 'Phase3', logprobs }) });
const CASE = { name: 'Arrosage des tomates (fictif)', context: 'Jardin partagé (fictif)' };

describe('LogprobDistributionStrategy', () => {
  it('throws without logprobs instead of reading the phase name from the text', async () => {
    await assert.rejects(strategy([]).evaluate(CASE as never), /no logprobs/);
  });

  it('throws when no alternative is a phase token, or when none discriminates', () => {
    assert.throws(() => extractPhaseProbabilities([{ token: 'Hmm', logprob: -0.1 }]), /no phase token/);
    assert.throws(() => extractPhaseProbabilities([{ token: 'Phase', logprob: -0.1 }]), /discriminates/);
  });

  it('reads a distribution from discriminating phase tokens', async () => {
    const out = await strategy([{ token: 'Phase3', logprob: -0.1 }, { token: 'Phase2', logprob: -2.5 }]).evaluate(CASE as never);
    assert.ok(out.evolution > 0.4 && out.evolution < 0.5);
  });
});
