// Unit tests for s-curve pure math functions.
// Migrated from the former self-test block in s-curve.mts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sigmoid,
  bandUpper,
  bandLower,
  centerCurve,
  isInBand,
  classifyZone,
  bandDistance,
  projectOnCurve,
  computeEvolution,
  pubEvolution,
  DEFAULT_PARAMS,
  PUB_TYPE_CENTROIDS,
} from './s-curve.mjs';

describe('s-curve — sigmoid primitives', () => {
  it('sigmoid(x0, k, x0) = 0.5', () => {
    assert.equal(sigmoid(0.3, 8, 0.3), 0.5);
  });

  it('sigmoid is monotonic increasing', () => {
    const a = sigmoid(0.2, 8, 0.5);
    const b = sigmoid(0.5, 8, 0.5);
    const c = sigmoid(0.8, 8, 0.5);
    assert.ok(a < b && b < c, `expected monotonic, got ${a}, ${b}, ${c}`);
  });

  it('bandUpper > bandLower across the [0,1] range', () => {
    for (const c of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const up = bandUpper(c);
      const lo = bandLower(c);
      assert.ok(up >= lo, `at c=${c}: upper=${up}, lower=${lo}`);
    }
  });

  it('centerCurve is the midpoint of the two band boundaries', () => {
    for (const c of [0.2, 0.5, 0.8]) {
      const mid = (bandUpper(c) + bandLower(c)) / 2;
      assert.equal(centerCurve(c), mid);
    }
  });
});

describe('s-curve — zone classification', () => {
  it('Point A (c=0.28, u=0.50) is extra-competitive-market', () => {
    assert.equal(classifyZone(0.28, 0.50), 'extra-competitive-market');
    assert.equal(isInBand(0.28, 0.50), false);
  });

  it('Point B (c=0.63, u=0.74) is competitive', () => {
    assert.equal(classifyZone(0.63, 0.74), 'competitive');
    assert.equal(isInBand(0.63, 0.74), true);
  });

  it('bandDistance is positive inside the band, negative outside', () => {
    const inside = bandDistance(0.63, 0.74);
    const outside = bandDistance(0.1, 0.9);
    assert.ok(inside > 0, `inside should be positive, got ${inside}`);
    assert.ok(outside < 0, `outside should be negative, got ${outside}`);
  });
});

describe('s-curve — projectOnCurve', () => {
  it('returns evolution in [0, 1]', () => {
    for (const [c, u] of [[0, 0], [0.5, 0.5], [1, 1], [0.28, 0.5], [0.63, 0.74]]) {
      const { evolution, distToCenter } = projectOnCurve(c as number, u as number);
      assert.ok(evolution >= 0 && evolution <= 1, `evolution out of range: ${evolution}`);
      assert.ok(distToCenter >= 0, `distance must be non-negative: ${distToCenter}`);
    }
  });
});

describe('s-curve — computeEvolution', () => {
  it('maps Point B to competitive / Product or Commodity phase', () => {
    const r = computeEvolution(0.63, 0.74);
    assert.equal(r.zone, 'competitive');
    assert.ok(['Product', 'Commodity'].includes(r.phase), `unexpected phase: ${r.phase}`);
    assert.ok(r.evolution >= 0 && r.evolution <= 1);
  });

  it('handles boundary inputs c=0, u=0 and c=1, u=1', () => {
    const a = computeEvolution(0, 0);
    const b = computeEvolution(1, 1);
    assert.ok(a.phase === 'Genesis' || a.phase === 'Custom');
    assert.equal(b.phase, 'Commodity');
  });
});

describe('s-curve — pubEvolution', () => {
  it('returns null when all inputs are zero', () => {
    assert.equal(pubEvolution(0, 0, 0, 0), null);
  });

  it('pure wonder yields the wonder centroid', () => {
    assert.equal(pubEvolution(1, 0, 0, 0), PUB_TYPE_CENTROIDS.wonder);
  });

  it('pure usage yields the usage centroid', () => {
    assert.equal(pubEvolution(0, 0, 0, 1), PUB_TYPE_CENTROIDS.usage);
  });

  it('normalizes a mixed distribution to a scalar in [0, 1]', () => {
    const v = pubEvolution(0.02, 0.08, 0.25, 0.65);
    assert.ok(v !== null && v > PUB_TYPE_CENTROIDS.operate && v < PUB_TYPE_CENTROIDS.usage);
  });
});

describe('s-curve — parameter defaults', () => {
  it('DEFAULT_PARAMS has 10 calibratable fields', () => {
    assert.equal(Object.keys(DEFAULT_PARAMS).length, 10);
  });
});
