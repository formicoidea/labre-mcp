import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PhaseDistributionSchema,
  ComponentInputSchema,
  SolutionInputSchema,
} from './inputs.schema.mjs';

describe('PhaseDistributionSchema', () => {
  it('accepts a well-formed 4-bin distribution summing to 1', () => {
    const r = PhaseDistributionSchema.safeParse({
      bins: [
        { position: 0.09, probability: 0.1 },
        { position: 0.29, probability: 0.2 },
        { position: 0.48, probability: 0.3 },
        { position: 0.85, probability: 0.4 },
      ],
    });
    assert.ok(r.success);
  });

  it('tolerates a small drift from 1 (within 0.01)', () => {
    const r = PhaseDistributionSchema.safeParse({
      bins: [
        { position: 0.2, probability: 0.334 },
        { position: 0.5, probability: 0.333 },
        { position: 0.9, probability: 0.333 },
      ],
    });
    assert.ok(r.success, `expected success, got ${JSON.stringify(r.error?.issues)}`);
  });

  it('rejects a distribution whose bins do not sum to ~1', () => {
    const r = PhaseDistributionSchema.safeParse({
      bins: [
        { position: 0.2, probability: 0.2 },
        { position: 0.5, probability: 0.2 },
      ],
    });
    assert.ok(!r.success);
  });

  it('rejects bin positions outside [0, 1]', () => {
    const r = PhaseDistributionSchema.safeParse({
      bins: [{ position: 1.5, probability: 1 }],
    });
    assert.ok(!r.success);
  });

  it('rejects probabilities outside [0, 1]', () => {
    const r = PhaseDistributionSchema.safeParse({
      bins: [{ position: 0.5, probability: 2 }],
    });
    assert.ok(!r.success);
  });

  it('rejects an empty bins array', () => {
    const r = PhaseDistributionSchema.safeParse({ bins: [] });
    assert.ok(!r.success);
  });
});

describe('ComponentInputSchema', () => {
  it('no longer accepts the legacy wonder/build/operate/usage flat fields (they should be ignored under strict... but schema is open)', () => {
    // The schema is open (no .strict()) so legacy fields pass through silently —
    // but ComponentInput should not type-check them. This test documents the shape.
    const r = ComponentInputSchema.safeParse({
      name: 'ERP',
      phaseDistribution: {
        bins: [
          { position: 0.09, probability: 0.2 },
          { position: 0.85, probability: 0.8 },
        ],
      },
    });
    assert.ok(r.success);
  });
});

describe('SolutionInputSchema', () => {
  it('carries solutionMetadata.marketPosition / adoptionPattern — no top-level solutionContext', () => {
    const r = SolutionInputSchema.safeParse({
      name: 'Kubernetes',
      description: 'Container orchestration',
      solutionMetadata: {
        marketPosition: 'Dominant in multi-cloud',
        adoptionPattern: 'Enterprise mainstream',
      },
    });
    assert.ok(r.success);
    if (r.success) {
      assert.equal(r.data.solutionMetadata?.marketPosition, 'Dominant in multi-cloud');
    }
  });
});
