import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_CENTROIDS,
  phase4Distribution,
} from '../schemas/inputs.schema.mjs';
import {
  centroidEvolution,
  entropyConfidence,
  concentrationConfidence,
} from './phase-distribution.mjs';

describe('phase4Distribution', () => {
  it('places probabilities on the canonical phase centroids', () => {
    const d = phase4Distribution(0.1, 0.2, 0.3, 0.4);
    assert.equal(d.bins.length, 4);
    assert.equal(d.bins[0].position, PHASE_CENTROIDS.phase1);
    assert.equal(d.bins[3].position, PHASE_CENTROIDS.phase4);
    assert.equal(d.bins[2].probability, 0.3);
  });
});

describe('centroidEvolution', () => {
  it('is 0 for an all-zero distribution (defensive, no division by zero)', () => {
    const d = phase4Distribution(0, 0, 0, 0);
    assert.equal(centroidEvolution(d), 0);
  });

  it('returns the phase centroid for a one-hot distribution', () => {
    assert.equal(centroidEvolution(phase4Distribution(1, 0, 0, 0)), PHASE_CENTROIDS.phase1);
    assert.equal(centroidEvolution(phase4Distribution(0, 1, 0, 0)), PHASE_CENTROIDS.phase2);
    assert.equal(centroidEvolution(phase4Distribution(0, 0, 1, 0)), PHASE_CENTROIDS.phase3);
    assert.equal(centroidEvolution(phase4Distribution(0, 0, 0, 1)), PHASE_CENTROIDS.phase4);
  });

  it('normalizes unnormalized distributions before averaging', () => {
    const normalized = centroidEvolution(phase4Distribution(0.2, 0, 0, 0.8));
    const doubled = centroidEvolution(phase4Distribution(0.4, 0, 0, 1.6));
    assert.equal(normalized, doubled);
  });
});

describe('entropyConfidence', () => {
  it('reports max confidence (1) on a one-hot distribution', () => {
    const c = entropyConfidence(phase4Distribution(1, 0, 0, 0));
    assert.equal(c, 1);
  });

  it('reports lower confidence on a uniform distribution than a peaked one', () => {
    const peaked = entropyConfidence(phase4Distribution(0.9, 0.05, 0.03, 0.02));
    const uniform = entropyConfidence(phase4Distribution(0.25, 0.25, 0.25, 0.25));
    assert.ok(peaked > uniform, `expected peaked > uniform, got peaked=${peaked} uniform=${uniform}`);
  });

  it('never drops below the 0.1 floor', () => {
    const uniform = entropyConfidence(phase4Distribution(0.25, 0.25, 0.25, 0.25));
    assert.ok(uniform >= 0.1);
  });
});

describe('concentrationConfidence', () => {
  it('reports high confidence on a peaked distribution', () => {
    const peaked = concentrationConfidence(phase4Distribution(0.9, 0.05, 0.03, 0.02));
    assert.ok(peaked > 0.7, `expected > 0.7, got ${peaked}`);
  });

  it('reports the clamped minimum (0.2) on a uniform distribution', () => {
    const uniform = concentrationConfidence(phase4Distribution(0.25, 0.25, 0.25, 0.25));
    assert.ok(uniform >= 0.2 && uniform <= 0.35, `uniform confidence should be near minimum, got ${uniform}`);
  });

  it('reports 0.2 for an all-zero distribution (defensive)', () => {
    const empty = concentrationConfidence(phase4Distribution(0, 0, 0, 0));
    assert.equal(empty, 0.2);
  });
});
