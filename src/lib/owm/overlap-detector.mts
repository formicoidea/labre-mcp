// Pure rectangle / segment intersection toolkit. Operates on a
// `SvgGeometry` produced by `svg-bbox-parser.mts` — has no
// knowledge of cli-owm, of the OWM DSL, or of the pipeline. Any
// future engine that produces an `SvgGeometry` reuses this module
// unchanged.
//
// V3 enforces three classes of constraint surfaced by
// `detectAllOverlaps`:
//
//   - **hard**  : label↔label, label↔component (own circle included),
//                 label↔canvas-overflow.
//   - **soft**  : label↔edge for an edge that is NOT incident to the
//                 label's own component.
//
// Severity:
//   - rect-rect : intersection area in pixels².
//   - canvas    : area of the bbox that falls outside the canvas.
//   - edge      : pixel length of the segment inside the label rect.
//
// Algorithmic complexity is O(n²) over rectangle pairs plus O(n × e)
// over (label, edge) pairs. For chain maps (n < 50, e < 80), this
// sits in the microseconds and the asymptotics are irrelevant.

import type {
  Bbox,
  Canvas,
  EdgeSegment,
  GeometryItem,
  GeometryReport,
  SvgGeometry,
} from './svg-bbox-parser.mjs';

/** Threshold (px²) below which a rect-rect overlap area is treated as
 *  zero (anti-jitter against floating-point noise from text bbox
 *  approximation). */
export const OVERLAP_THRESHOLD_PX = 1;

/** Threshold (px) below which a label↔edge crossing length is treated
 *  as zero (segment grazes the label corner). */
export const EDGE_CROSSING_THRESHOLD_PX = 1;

/** Minimum visual gap between two label rectangles. Below this, even
 *  without overlap, the labels feel visually merged and the
 *  detector emits a `label-spacing` soft violation. Empirical, set
 *  to one full LABEL_HEIGHT (16 px) per user calibration on
 *  2026-05-06. */
export const MIN_LABEL_SPACING_PX = 16;

export type OverlapKind =
  | 'anchor-anchor'
  | 'anchor-component'
  | 'anchor-label'
  | 'component-component'
  | 'component-label'
  | 'label-label'
  | 'label-canvas'
  | 'label-edge'
  | 'label-spacing'
  | 'label-axis';

/** Synthetic geometry item used for non-rect targets in overlap
 *  reports (canvas, edges, phase axes). Has the same shape as
 *  `GeometryItem` so consumers can treat the `b` side uniformly. */
export interface SyntheticGeometry {
  name: string;
  kind: 'canvas' | 'edge' | 'axis';
  bbox: Bbox;
}

export interface Overlap {
  /** Always a parsed GeometryItem (component / label / anchor). */
  a: GeometryItem;
  /** Either another GeometryItem (rect-rect overlap) or a synthetic
   *  item for canvas-overflow, edge-crossing, or phase-axis-crossing
   *  reports. The synthetic bbox is the offending region. */
  b: GeometryItem | SyntheticGeometry;
  kind: OverlapKind;
  /** Pixel² for rect-rect, pixel² of overflow for canvas, pixel
   *  length for edge crossings, slack-to-min for label-spacing,
   *  bbox-axis crossing width for label-axis. */
  severity: number;
}

// ─── Rectangle math ────────────────────────────────────────────────────

function intersectionArea(a: Bbox, b: Bbox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width,  b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

/**
 * Chebyshev gap between two axis-aligned rectangles : the larger of
 * the horizontal and vertical separations. Returns 0 when the
 * rectangles overlap. This metric matches the way labels feel
 * visually distinct: two labels diagonally offset by (5, 5) are as
 * visually merged as two side-by-side at (5, 0).
 */
export function rectGap(a: Bbox, b: Bbox): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)));
  return Math.max(dx, dy);
}

/**
 * How much of `bbox` is on each side of the vertical line `axisX`,
 * doubled. A label centered exactly on the axis returns its full
 * width ; a label barely grazing the axis returns near-0. Returns
 * 0 when the axis does not pierce the bbox.
 */
export function bboxAxisCrossingWidth(bbox: Bbox, axisX: number): number {
  if (axisX <= bbox.x || axisX >= bbox.x + bbox.width) return 0;
  return Math.min(axisX - bbox.x, bbox.x + bbox.width - axisX) * 2;
}

function pairKind(a: GeometryItem['kind'], b: GeometryItem['kind']): OverlapKind {
  // Sort the two kinds alphabetically so (label, component) and
  // (component, label) collapse to the same key.
  const sorted = [a, b].sort();
  return `${sorted[0]}-${sorted[1]}` as OverlapKind;
}

// ─── Canvas overflow ───────────────────────────────────────────────────

/**
 * Area (px²) of `bbox` that falls outside the rectangle
 * `[0, 0, canvas.width, canvas.height]`. Returns 0 when canvas is
 * undefined (width or height ≤ 0) — caller should treat that as
 * "canvas constraint not applicable" rather than "no overflow".
 */
export function bboxOutsideCanvasArea(bbox: Bbox, canvas: Canvas): number {
  if (canvas.width <= 0 || canvas.height <= 0) return 0;
  const fullArea = bbox.width * bbox.height;
  if (fullArea <= 0) return 0;
  const x1 = Math.max(0, bbox.x);
  const y1 = Math.max(0, bbox.y);
  const x2 = Math.min(canvas.width,  bbox.x + bbox.width);
  const y2 = Math.min(canvas.height, bbox.y + bbox.height);
  if (x2 <= x1 || y2 <= y1) return fullArea; // entirely outside
  const insideArea = (x2 - x1) * (y2 - y1);
  return Math.max(0, fullArea - insideArea);
}

// ─── Segment ↔ Rectangle ───────────────────────────────────────────────

function pointInRect(px: number, py: number, r: Bbox): boolean {
  return px >= r.x && px <= r.x + r.width
      && py >= r.y && py <= r.y + r.height;
}

/** Standard 2D segment-segment intersection via orientation tests. */
function segmentSegmentIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const o2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const o3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const o4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))
      && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

/**
 * True iff the segment from (seg.x1, seg.y1) to (seg.x2, seg.y2)
 * intersects the axis-aligned rectangle `rect`. Considers both
 * endpoint-inside and segment-crossing-edge cases.
 */
export function segmentRectIntersects(seg: EdgeSegment, rect: Bbox): boolean {
  if (pointInRect(seg.x1, seg.y1, rect)) return true;
  if (pointInRect(seg.x2, seg.y2, rect)) return true;
  const lx = rect.x, ty = rect.y;
  const rx = rect.x + rect.width, by = rect.y + rect.height;
  return segmentSegmentIntersect(seg.x1, seg.y1, seg.x2, seg.y2, lx, ty, rx, ty)
      || segmentSegmentIntersect(seg.x1, seg.y1, seg.x2, seg.y2, rx, ty, rx, by)
      || segmentSegmentIntersect(seg.x1, seg.y1, seg.x2, seg.y2, rx, by, lx, by)
      || segmentSegmentIntersect(seg.x1, seg.y1, seg.x2, seg.y2, lx, by, lx, ty);
}

/**
 * Pixel length of the portion of `seg` that lies inside `rect`,
 * computed via Liang-Barsky parametric clipping. Returns 0 when the
 * segment misses the rectangle entirely.
 */
export function segmentInRectLength(seg: EdgeSegment, rect: Bbox): number {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  let t0 = 0, t1 = 1;

  const p = [-dx, dx, -dy, dy];
  const q = [
    seg.x1 - rect.x,
    (rect.x + rect.width) - seg.x1,
    seg.y1 - rect.y,
    (rect.y + rect.height) - seg.y1,
  ];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return 0; // parallel and outside
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return 0;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return 0;
      if (t < t1) t1 = t;
    }
  }
  if (t1 < t0) return 0;
  const cx = (t1 - t0) * dx;
  const cy = (t1 - t0) * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

// ─── Synthetic geometry items for overlap reports ──────────────────────

function canvasItem(canvas: Canvas): { name: string; kind: 'canvas'; bbox: Bbox } {
  return {
    name: '__canvas__',
    kind: 'canvas',
    bbox: { x: 0, y: 0, width: canvas.width, height: canvas.height },
  };
}

function edgeItem(edge: EdgeSegment): { name: string; kind: 'edge'; bbox: Bbox } {
  const x = Math.min(edge.x1, edge.x2);
  const y = Math.min(edge.y1, edge.y2);
  const width = Math.abs(edge.x2 - edge.x1);
  const height = Math.abs(edge.y2 - edge.y1);
  return {
    name: `${edge.from}->${edge.to}`,
    kind: 'edge',
    bbox: { x, y, width, height },
  };
}

function axisItem(axisX: number, height: number): { name: string; kind: 'axis'; bbox: Bbox } {
  return {
    name: `__axis__@${axisX.toFixed(1)}`,
    kind: 'axis',
    bbox: { x: axisX, y: 0, width: 0, height },
  };
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * V2 — pairwise rectangle overlap detection over a flat geometry
 * report. Self-overlaps (same `name` + `kind`) are filtered out, but
 * unlike V2 we DO report (component, label) pairs of the same name —
 * the V3 business rule says a label must not overlap any node circle,
 * including its own. Sorted by descending severity.
 */
export function detectOverlaps(geometry: GeometryReport): Overlap[] {
  const overlaps: Overlap[] = [];
  for (let i = 0; i < geometry.length; i++) {
    for (let j = i + 1; j < geometry.length; j++) {
      const a = geometry[i];
      const b = geometry[j];
      // Same-name same-kind is identity (parser uniqueness invariant) —
      // skip defensively. Same-name cross-kind (component vs label of
      // the same component) is now reported.
      if (a.name === b.name && a.kind === b.kind) continue;
      const area = intersectionArea(a.bbox, b.bbox);
      if (area <= OVERLAP_THRESHOLD_PX) continue;
      overlaps.push({ a, b, kind: pairKind(a.kind, b.kind), severity: area });
    }
  }
  overlaps.sort((p, q) => q.severity - p.severity);
  return overlaps;
}

/**
 * V3 — full overlap pass over `SvgGeometry`. Combines:
 *   - `detectOverlaps` (rect-rect)
 *   - canvas-overflow per label
 *   - label↔edge crossings, skipping edges incident to the label's
 *     own component
 *
 * Returned list is sorted by descending severity. Severity unit
 * differs by kind (px² for rect-rect and canvas, px for edges) — the
 * caller weights them with HARD/SOFT penalties.
 */
export function detectAllOverlaps(geometry: SvgGeometry): Overlap[] {
  const out: Overlap[] = detectOverlaps(geometry.items);

  // Canvas-overflow: only labels can be moved by verify-layout, so
  // we only report overflow for labels. Components and anchors are
  // pinned upstream and out-of-scope here.
  if (geometry.canvas.width > 0 && geometry.canvas.height > 0) {
    const synthCanvas = canvasItem(geometry.canvas);
    for (const item of geometry.items) {
      if (item.kind !== 'label') continue;
      const overflow = bboxOutsideCanvasArea(item.bbox, geometry.canvas);
      if (overflow <= OVERLAP_THRESHOLD_PX) continue;
      out.push({ a: item, b: synthCanvas, kind: 'label-canvas', severity: overflow });
    }
  }

  // Label↔edge: a label colliding with an edge incident to its own
  // component is expected (the line starts/ends at the component
  // circle, naturally near the label). Skip those pairs by name.
  for (const item of geometry.items) {
    if (item.kind !== 'label') continue;
    for (const edge of geometry.edges) {
      if (edge.from === item.name || edge.to === item.name) continue;
      if (!segmentRectIntersects(edge, item.bbox)) continue;
      const length = segmentInRectLength(edge, item.bbox);
      if (length <= EDGE_CROSSING_THRESHOLD_PX) continue;
      out.push({ a: item, b: edgeItem(edge), kind: 'label-edge', severity: length });
    }
  }

  // Label↔label spacing: labels that don't strictly overlap but are
  // closer than MIN_LABEL_SPACING_PX feel visually merged. Sevirity
  // is the missing slack to reach the minimum gap.
  const labels = geometry.items.filter(it => it.kind === 'label');
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      // If they already overlap, the rect-rect pass above caught it
      // with kind 'label-label'. Spacing only applies to non-overlapping
      // pairs.
      if (intersectionArea(a.bbox, b.bbox) > 0) continue;
      const gap = rectGap(a.bbox, b.bbox);
      if (gap >= MIN_LABEL_SPACING_PX) continue;
      out.push({
        a, b,
        kind: 'label-spacing',
        severity: MIN_LABEL_SPACING_PX - gap,
      });
    }
  }

  // Label↔phase-axis: visually distracting when a label straddles a
  // phase boundary line. Severity is bboxAxisCrossingWidth.
  if (geometry.phaseAxes.length > 0 && geometry.canvas.height > 0) {
    for (const item of geometry.items) {
      if (item.kind !== 'label') continue;
      for (const axisX of geometry.phaseAxes) {
        const w = bboxAxisCrossingWidth(item.bbox, axisX);
        if (w <= 0) continue;
        out.push({
          a: item,
          b: axisItem(axisX, geometry.canvas.height),
          kind: 'label-axis',
          severity: w,
        });
      }
    }
  }

  out.sort((p, q) => q.severity - p.severity);
  return out;
}
