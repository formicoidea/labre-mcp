// Tests for publication-analysis-strategy parsing robustness.
//
// Regression: multilingual prose (e.g. French) preceding the final
// `key=value` block could cause the prior lenient regex to capture a
// bare "." (from sentence punctuation), producing NaN that silently
// traversed the arithmetic and only surfaced at validateResult.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PublicationAnalysisStrategy,
  parsePubResponse,
} from './publication-analysis-strategy.mjs';

describe('publication-analysis — parsePubResponse', () => {
  it('parses a standard English response', () => {
    const text = `Some reasoning here.
phase1=0.10
phase2=0.30
phase3=0.40
phase4=0.20`;
    assert.deepEqual(parsePubResponse(text), { p1: 0.10, p2: 0.30, p3: 0.40, p4: 0.20 });
  });

  it('parses a French-prose response that mentions phase keywords before the final block', () => {
    const text = `Analyse : très peu d'indicateurs phase1.
Les signaux phase2 sont nombreux. Le phase3 domine. phase4 en retrait.
phase1=0.05
phase2=0.40
phase3=0.35
phase4=0.20`;
    assert.deepEqual(parsePubResponse(text), { p1: 0.05, p2: 0.40, p3: 0.35, p4: 0.20 });
  });

  it('tolerates the colon form', () => {
    const text = `phase1: 0.1
phase2: 0.2
phase3: 0.3
phase4: 0.4`;
    assert.deepEqual(parsePubResponse(text), { p1: 0.1, p2: 0.2, p3: 0.3, p4: 0.4 });
  });

  it('throws a parse error when a key is missing', () => {
    const text = `phase1=0.1
phase2=0.2
phase3=0.3`;
    assert.throws(() => parsePubResponse(text), /could not parse response/);
  });

  it('rejects a bare "." value', () => {
    const text = `phase1=.
phase2=0.2
phase3=0.3
phase4=0.4`;
    assert.throws(() => parsePubResponse(text), /could not parse response/);
  });

  it('rejects a negative value at the regex stage', () => {
    const text = `phase1=-0.1
phase2=0.2
phase3=0.3
phase4=0.4`;
    assert.throws(() => parsePubResponse(text), /could not parse response/);
  });
});

describe('publication-analysis — evaluate()', () => {
  it('returns a finite evolution from a French-prose injected LLM response', async () => {
    const llmCall = async () => `Raisonnement en français sur phase1 et phase2.
Conclusion :
phase1=0.10
phase2=0.25
phase3=0.40
phase4=0.25`;
    const strategy = new PublicationAnalysisStrategy({ llmCall });
    const result = await strategy.evaluate({ name: 'Test', context: 'ctx' });
    assert.equal(result.method, 'publication-analysis');
    assert.ok(Number.isFinite(result.evolution), 'evolution must be finite');
    assert.ok(result.evolution >= 0 && result.evolution <= 1, 'evolution in [0,1]');
    assert.ok(Number.isFinite(result.confidence));
  });

  it('uses component.phaseDistribution when provided (skips the LLM)', async () => {
    const strategy = new PublicationAnalysisStrategy();
    const result = await strategy.evaluate({
      name: 'Test',
      context: 'ctx',
      phaseDistribution: {
        bins: [
          { position: 0.09, probability: 0 },
          { position: 0.29, probability: 0 },
          { position: 0.48, probability: 0.2 },
          { position: 0.85, probability: 0.8 },
        ],
      },
    });
    assert.equal(result.method, 'publication-analysis');
    assert.ok(result.evolution > 0.7);
  });
});
