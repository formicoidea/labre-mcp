// Tests for overlap-detector.mts — pure rectangle / segment math.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectOverlaps,
  detectAllOverlaps,
  segmentRectIntersects,
  segmentInRectLength,
  bboxOutsideCanvasArea,
  OVERLAP_THRESHOLD_PX,
  EDGE_CROSSING_THRESHOLD_PX,
} from './overlap-detector.mjs';
import type {
  Bbox,
  Canvas,
  EdgeSegment,
  GeometryItem,
  SvgGeometry,
} from './svg-bbox-parser.mjs';

function rect(name: string, kind: GeometryItem['kind'], x: number, y: number, w: number, h: number): GeometryItem {
  return { name, kind, bbox: { x, y, width: w, height: h } };
}

function bbox(x: number, y: number, w: number, h: number): Bbox {
  return { x, y, width: w, height: h };
}

function seg(x1: number, y1: number, x2: number, y2: number, from = 'A', to = 'B'): EdgeSegment {
  return { from, to, x1, y1, x2, y2 };
}

describe('detectOverlaps — pairwise rect-rect', () => {
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
    assert.equal(out[0].severity, 100);
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

  it('REPORTS label vs its own component circle (V3 regression)', () => {
    // V2 silently dropped this pair. V3 must detect it because the
    // business rule says a label must not overlap any node circle.
    const out = detectOverlaps([
      rect('Foo', 'component', 100, 100, 10, 10),
      rect('Foo', 'label',     105, 100, 50, 14),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'component-label');
    assert.equal(out[0].a.name, 'Foo');
    assert.equal(out[0].b.name, 'Foo');
  });

  it('drops intersections below the noise threshold', () => {
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
      rect('B', 'label', 50, 50, 100, 100),  // 50×50=2500
      rect('C', 'label', 90, 90, 20, 20),    // 10×10=100 with A
    ]);
    assert.equal(out.length, 3);
    assert.ok(out[0].severity >= out[1].severity);
    assert.ok(out[1].severity >= out[2].severity);
  });
});

describe('bboxOutsideCanvasArea', () => {
  const canvas: Canvas = { width: 100, height: 100 };

  it('returns 0 when the bbox is entirely inside the canvas', () => {
    assert.equal(bboxOutsideCanvasArea(bbox(10, 10, 20, 20), canvas), 0);
  });

  it('returns the full bbox area when entirely outside', () => {
    assert.equal(bboxOutsideCanvasArea(bbox(200, 200, 50, 50), canvas), 50 * 50);
  });

  it('returns the overflow area when partially outside', () => {
    // Bbox (90, 90, 30, 30) — 30×30=900 total; inside is (90..100, 90..100)=10×10=100; overflow 800.
    assert.equal(bboxOutsideCanvasArea(bbox(90, 90, 30, 30), canvas), 900 - 100);
  });

  it('returns 0 when the canvas reference is undefined', () => {
    assert.equal(bboxOutsideCanvasArea(bbox(0, 0, 10, 10), { width: 0, height: 0 }), 0);
  });
});

describe('segmentRectIntersects', () => {
  const r: Bbox = { x: 100, y: 100, width: 50, height: 50 };

  it('returns true when an endpoint is inside the rect', () => {
    assert.ok(segmentRectIntersects(seg(120, 120, 200, 200), r));
  });

  it('returns true when the segment crosses the rect', () => {
    assert.ok(segmentRectIntersects(seg(0, 125, 300, 125), r));
  });

  it('returns false when the segment misses the rect', () => {
    assert.equal(segmentRectIntersects(seg(0, 0, 10, 10), r), false);
  });

  it('returns false when the segment lies entirely beside the rect (no crossing)', () => {
    assert.equal(segmentRectIntersects(seg(0, 0, 99, 99), r), false);
  });
});

describe('segmentInRectLength', () => {
  const r: Bbox = { x: 0, y: 0, width: 100, height: 100 };

  it('returns 0 for a segment fully outside', () => {
    assert.equal(segmentInRectLength(seg(200, 200, 300, 300), r), 0);
  });

  it('returns the full length for a segment fully inside', () => {
    // segment (10,10)→(40,50) inside [0,100]² → length √(30²+40²) = 50
    assert.equal(segmentInRectLength(seg(10, 10, 40, 50), r), 50);
  });

  it('clips a horizontal segment crossing the rect', () => {
    // segment (-50, 50)→(150, 50) clips to (0,50)→(100,50) → length 100
    assert.equal(segmentInRectLength(seg(-50, 50, 150, 50), r), 100);
  });
});

describe('detectAllOverlaps — combined V3 detection', () => {
  function geom(items: GeometryItem[], edges: EdgeSegment[] = [], canvas: Canvas = { width: 0, height: 0 }): SvgGeometry {
    return { items, edges, canvas };
  }

  it('forwards rect-rect overlaps from detectOverlaps', () => {
    const out = detectAllOverlaps(geom([
      rect('A', 'label', 0, 0, 20, 20),
      rect('B', 'label', 10, 10, 20, 20),
    ]));
    const labelLabel = out.filter(o => o.kind === 'label-label');
    assert.equal(labelLabel.length, 1);
  });

  it('reports label-canvas when a label spills off the canvas', () => {
    const out = detectAllOverlaps(geom(
      [rect('A', 'label', 80, 0, 50, 14)], // half outside x=100 boundary
      [],
      { width: 100, height: 100 },
    ));
    const overflow = out.filter(o => o.kind === 'label-canvas');
    assert.equal(overflow.length, 1);
    assert.equal(overflow[0].a.name, 'A');
    assert.ok(overflow[0].severity > 0);
  });

  it('skips label-canvas check when canvas dimensions are unknown', () => {
    const out = detectAllOverlaps(geom(
      [rect('A', 'label', 80, 0, 50, 14)],
      [],
      { width: 0, height: 0 },
    ));
    assert.equal(out.filter(o => o.kind === 'label-canvas').length, 0);
  });

  it('reports label-edge when a third-party edge crosses the label', () => {
    const out = detectAllOverlaps(geom(
      [rect('Z', 'label', 50, 50, 40, 14)],
      [seg(0, 57, 200, 57, 'X', 'Y')], // line through Z's label
    ));
    const edgeOv = out.filter(o => o.kind === 'label-edge');
    assert.equal(edgeOv.length, 1);
    assert.equal(edgeOv[0].a.name, 'Z');
    assert.ok(edgeOv[0].severity > 0);
  });

  it('does NOT report label-edge for an edge incident to the label\'s own component', () => {
    const out = detectAllOverlaps(geom(
      [rect('Z', 'label', 50, 50, 40, 14)],
      [
        seg(0, 57, 200, 57, 'Z', 'Other'),     // Z is endpoint → ignored
        seg(0, 57, 200, 57, 'Other', 'Z'),     // Z is other endpoint → ignored
      ],
    ));
    assert.equal(out.filter(o => o.kind === 'label-edge').length, 0);
  });

  it('combines hard + soft overlaps in the same report', () => {
    const out = detectAllOverlaps(geom(
      [
        rect('A', 'label', 0, 0, 20, 20),     // overlaps B
        rect('B', 'label', 10, 10, 20, 20),
        rect('C', 'label', 50, 50, 40, 14),   // crossed by edge
      ],
      [seg(0, 57, 200, 57, 'X', 'Y')],         // crosses C
      { width: 200, height: 200 },             // big enough, no canvas overflow
    ));
    const kinds = new Set(out.map(o => o.kind));
    assert.ok(kinds.has('label-label'));
    assert.ok(kinds.has('label-edge'));
  });
});

describe('overlap-detector — constants sanity', () => {
  it('thresholds are positive', () => {
    assert.ok(OVERLAP_THRESHOLD_PX > 0);
    assert.ok(EDGE_CROSSING_THRESHOLD_PX > 0);
  });
});
