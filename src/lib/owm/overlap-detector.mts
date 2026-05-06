// Pure rectangle-intersection collision detector. Operates on a
// `GeometryReport` produced by `svg-bbox-parser.mts` — has no
// knowledge of cli-owm, of the OWM DSL, or of the pipeline. Any
// future engine that produces a `GeometryReport` reuses this module
// unchanged.
//
// Algorithm: O(n²) brute force on rectangle pairs. For chain maps n
// stays well under 50, so the asymptotics are irrelevant here.

import type { Bbox, GeometryItem, GeometryKind, GeometryReport } from './svg-bbox-parser.mjs';

/** Threshold (px²) below which an overlap area is treated as zero
 *  (anti-jitter against floating-point noise from text bbox
 *  approximation). */
export const OVERLAP_THRESHOLD_PX = 1;

export interface Overlap {
  a: GeometryItem;
  b: GeometryItem;
  /** Cardinality kind, normalised so the (label, component) and
   *  (component, label) cases produce the same key. The two member
   *  kinds are sorted alphabetically. */
  kind:
    | 'anchor-anchor'
    | 'anchor-component'
    | 'anchor-label'
    | 'component-component'
    | 'component-label'
    | 'label-label';
  /** Pixel² area of the intersection rectangle. Ranks severity. */
  area: number;
}

function intersectionArea(a: Bbox, b: Bbox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width,  b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

function pairKind(a: GeometryKind, b: GeometryKind): Overlap['kind'] {
  // Sort the two kinds alphabetically so (label, component) and
  // (component, label) collapse to the same key.
  const sorted = [a, b].sort();
  return `${sorted[0]}-${sorted[1]}` as Overlap['kind'];
}

/**
 * Detect every pair of geometry items whose bboxes intersect by more
 * than OVERLAP_THRESHOLD_PX pixels squared. Self-overlaps (same
 * `name` + `kind`) are filtered out — a label naturally "overlaps"
 * its own component circle, which is not a problem to fix.
 */
export function detectOverlaps(geometry: GeometryReport): Overlap[] {
  const overlaps: Overlap[] = [];
  for (let i = 0; i < geometry.length; i++) {
    for (let j = i + 1; j < geometry.length; j++) {
      const a = geometry[i];
      const b = geometry[j];
      // Same component (label vs its own circle): expected, not a clash.
      if (a.name === b.name) continue;
      const area = intersectionArea(a.bbox, b.bbox);
      if (area <= OVERLAP_THRESHOLD_PX) continue;
      overlaps.push({ a, b, kind: pairKind(a.kind, b.kind), area });
    }
  }
  // Sort by descending severity so callers can fix the worst case first.
  overlaps.sort((p, q) => q.area - p.area);
  return overlaps;
}
