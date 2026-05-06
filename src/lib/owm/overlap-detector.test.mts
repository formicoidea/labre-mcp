// Tests for overlap-detector.mts — pure rectangle math.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectOverlaps,
  OVERLAP_THRESHOLD_PX,
} from './overlap-detector.mjs';
import type { GeometryItem } from './svg-bbox-parser.mjs';

function rect(name: string, kind: GeometryItem['kind'], x: number, y: number, w: number, h: number): GeometryItem {
  return { name, kind, bbox: { x, y, width: w, height: h } };
}

describe('detectOverlaps', () => {
  it('finds no overlaps when rectangles are disjoint', () => {
    const out = detectOverlaps([
      rect('A', 'label', 0, 0, 10, 10),
      rect('B', 'label', 100, 100, 10, 10),
    ]);
    assert.deepEqual(out, []);
  });

  it('finds an overlap between two intersecting labels', () => {
    const out = detectOverlaps([
      rect('A', 'label', 0, 0, 20, 20),
      rect('B', 'label', 10, 10, 20, 20),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'label-label');
    // Intersection rect: (10,10) to (20,20) → 10×10 = 100 px².
    assert.equal(out[0].area, 100);
  });

  it('classifies pair kinds symmetrically (alphabetical normalisation)', () => {
    const ll = detectOverlaps([
      rect('A', 'label',     0, 0, 10, 10),
      rect('B', 'component', 5, 5, 10, 10),
    ]);
    const cl = detectOverlaps([
      rect('A', 'component', 0, 0, 10, 10),
      rect('B', 'label',     5, 5, 10, 10),
    ]);
    assert.equal(ll[0].kind, 'component-label');
    assert.equal(cl[0].kind, 'component-label');
  });

  it('ignores self-overlap (label vs its own component circle)', () => {
    // The label of "Foo" naturally overlaps the circle of "Foo" by
    // design — this should NOT be reported as a collision.
    const out = detectOverlaps([
      rect('Foo', 'component', 100, 100, 10, 10),
      rect('Foo', 'label',     100, 95,  50, 14),
    ]);
    assert.deepEqual(out, []);
  });

  it('drops intersections below the noise threshold', () => {
    // Touching by exactly 1 px²: filtered.
    const out = detectOverlaps([
      rect('A', 'label', 0, 0, 10, 10),
      rect('B', 'label', 9, 9, 10, 10),
    ]);
    assert.deepEqual(out, []);
    assert.equal(OVERLAP_THRESHOLD_PX, 1);
  });

  it('orders results by descending severity', () => {
    const out = detectOverlaps([
      rect('A', 'label', 0, 0, 100, 100),
      // Big overlap with A: 50×50 = 2500.
      rect('B', 'label', 50, 50, 100, 100),
      // Small overlap with A: 10×10 = 100.
      rect('C', 'label', 90, 90, 20, 20),
    ]);
    assert.equal(out.length, 3);
    // First pair must be the worst.
    assert.ok(out[0].area >= out[1].area);
    assert.ok(out[1].area >= out[2].area);
  });

  it('handles multi-pair detection correctly (n>2)', () => {
    const out = detectOverlaps([
      rect('A', 'label', 0,   0,   30, 30),
      rect('B', 'label', 10,  10,  30, 30),
      rect('C', 'label', 200, 200, 10, 10),
      rect('D', 'label', 205, 205, 10, 10),
    ]);
    assert.equal(out.length, 2);
    assert.ok(out.find(o => o.a.name === 'A' && o.b.name === 'B'));
    assert.ok(out.find(o => o.a.name === 'C' && o.b.name === 'D'));
  });
});
