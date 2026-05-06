// Tests for overlap-detector.mts — pure rectangle / segment math.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectOverlaps,
  detectAllOverlaps,
  segmentRectIntersects,
  segmentInRectLength,
  bboxOutsideCanvasArea,
  rectGap,
  bboxAxisCrossingWidth,
  OVERLAP_THRESHOLD_PX,
  EDGE_CROSSING_THRESHOLD_PX,
  MIN_LABEL_SPACING_PX,
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

describe('rectGap (Chebyshev between rects)', () => {
  it('returns 0 when rects overlap', () => {
    assert.equal(rectGap(bbox(0, 0, 10, 10), bbox(5, 5, 10, 10)), 0);
  });
  it('returns horizontal gap when only X separated', () => {
    assert.equal(rectGap(bbox(0, 0, 10, 10), bbox(20, 0, 10, 10)), 10);
  });
  it('returns vertical gap when only Y separated', () => {
    assert.equal(rectGap(bbox(0, 0, 10, 10), bbox(0, 20, 10, 10)), 10);
  });
  it('returns max(dx, dy) for diagonal separation', () => {
    // dx = 20-10 = 10, dy = 30-10 = 20 → max = 20
    assert.equal(rectGap(bbox(0, 0, 10, 10), bbox(20, 30, 10, 10)), 20);
  });
});

describe('bboxAxisCrossingWidth', () => {
  it('returns 0 when the axis is to the left of the bbox', () => {
    assert.equal(bboxAxisCrossingWidth(bbox(50, 0, 30, 10), 40), 0);
  });
  it('returns 0 when the axis is to the right of the bbox', () => {
    assert.equal(bboxAxisCrossingWidth(bbox(50, 0, 30, 10), 90), 0);
  });
  it('returns full bbox width when the axis is centered', () => {
    // bbox 50..80, center=65. Axis at 65 → min(15, 15) × 2 = 30 = full width.
    assert.equal(bboxAxisCrossingWidth(bbox(50, 0, 30, 10), 65), 30);
  });
  it('returns smaller value when the axis is near an edge', () => {
    // bbox 50..80. Axis at 55 → min(5, 25) × 2 = 10.
    assert.equal(bboxAxisCrossingWidth(bbox(50, 0, 30, 10), 55), 10);
  });
});

describe('detectAllOverlaps — combined V3 detection', () => {
  function geom(
    items: GeometryItem[],
    edges: EdgeSegment[] = [],
    canvas: Canvas = { width: 0, height: 0 },
    phaseAxes: number[] = [],
    mapArea: Bbox = { x: 0, y: 0, width: canvas.width, height: canvas.height },
  ): SvgGeometry {
    return { items, edges, canvas, mapArea, phaseAxes };
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

  it('reports label-spacing when two labels are within MIN_LABEL_SPACING_PX', () => {
    // Two labels 10 px apart (< MIN_LABEL_SPACING_PX = 24) but not
    // overlapping. Should emit a label-spacing soft violation.
    const out = detectAllOverlaps(geom(
      [
        rect('A', 'label', 0,  0, 20, 14),
        rect('B', 'label', 30, 0, 20, 14),  // 10 px to the right of A
      ],
      [],
      { width: 200, height: 200 },
    ));
    const spacing = out.filter(o => o.kind === 'label-spacing');
    assert.equal(spacing.length, 1);
    assert.equal(spacing[0].severity, MIN_LABEL_SPACING_PX - 10);
  });

  it('does NOT report label-spacing when the gap is >= MIN_LABEL_SPACING_PX', () => {
    const out = detectAllOverlaps(geom(
      [
        rect('A', 'label',   0, 0, 20, 14),
        rect('B', 'label', 100, 0, 20, 14),  // 80 px gap
      ],
      [],
      { width: 200, height: 200 },
    ));
    assert.equal(out.filter(o => o.kind === 'label-spacing').length, 0);
  });

  it('does NOT report label-spacing when labels overlap (covered as label-label)', () => {
    // Overlapping pair → counted only once as 'label-label'.
    const out = detectAllOverlaps(geom(
      [
        rect('A', 'label', 0, 0, 20, 14),
        rect('B', 'label', 5, 5, 20, 14),
      ],
      [],
      { width: 200, height: 200 },
    ));
    assert.equal(out.filter(o => o.kind === 'label-label').length, 1);
    assert.equal(out.filter(o => o.kind === 'label-spacing').length, 0);
  });

  it('reports label-spacing when a label is too close to a foreign component circle', () => {
    // Reproduces the user-reported V4 case (Moteur de recommandation
    // label 17 px from Système d'abonnement circle, on the same Y
    // band → ambiguous).
    const out = detectAllOverlaps(geom(
      [
        rect('Lbl', 'label',     0, 0, 20, 14),
        rect('Far', 'component', 30, 0, 10, 10),  // 10 px gap, foreign
      ],
      [],
      { width: 200, height: 200 },
    ));
    const spacing = out.filter(o => o.kind === 'label-spacing');
    assert.equal(spacing.length, 1);
    assert.equal(spacing[0].a.name, 'Lbl');
    assert.equal(spacing[0].b.name, 'Far');
  });

  it('does NOT report label-spacing for the label of A vs the circle of A', () => {
    // The label naturally sits next to its own component circle.
    const out = detectAllOverlaps(geom(
      [
        rect('Foo', 'component', 100, 100, 10, 10),
        rect('Foo', 'label',     115, 100, 50, 14),  // dx=+20 sort of
      ],
      [],
      { width: 500, height: 500 },
    ));
    assert.equal(out.filter(o => o.kind === 'label-spacing').length, 0);
  });

  it('reports label-spacing when a label is too close to a foreign anchor text', () => {
    const out = detectAllOverlaps(geom(
      [
        rect('Lbl',  'label',  0, 0, 20, 14),
        rect('User', 'anchor', 30, 0, 30, 14),  // foreign anchor 10 px away
      ],
      [],
      { width: 200, height: 200 },
    ));
    const spacing = out.filter(o => o.kind === 'label-spacing');
    assert.equal(spacing.length, 1);
    assert.equal(spacing[0].b.name, 'User');
  });

  it('reports label-axis when a label straddles a phase axis line', () => {
    const out = detectAllOverlaps(geom(
      [rect('Z', 'label', 80, 50, 30, 14)],   // 80..110 in X
      [],
      { width: 200, height: 200 },
      [95, 200, 350],                          // axis at 95 (middle of label X)
    ));
    const axisOv = out.filter(o => o.kind === 'label-axis');
    assert.equal(axisOv.length, 1);
    assert.ok(axisOv[0].severity > 0);
  });

  it('does NOT report label-axis when the label sits clear of every axis', () => {
    const out = detectAllOverlaps(geom(
      [rect('Z', 'label', 50, 50, 30, 14)],   // 50..80
      [],
      { width: 200, height: 200 },
      [10, 100, 150],                          // none inside 50..80
    ));
    assert.equal(out.filter(o => o.kind === 'label-axis').length, 0);
  });

  it('skips label-axis when phaseAxes is empty (canvas info missing)', () => {
    const out = detectAllOverlaps(geom(
      [rect('Z', 'label', 80, 50, 30, 14)],
      [],
      { width: 200, height: 200 },
      [],
    ));
    assert.equal(out.filter(o => o.kind === 'label-axis').length, 0);
  });
});

describe('overlap-detector — constants sanity', () => {
  it('thresholds are positive', () => {
    assert.ok(OVERLAP_THRESHOLD_PX > 0);
    assert.ok(EDGE_CROSSING_THRESHOLD_PX > 0);
  });
});
