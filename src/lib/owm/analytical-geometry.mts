// Pure-JS replacement for `parseSvgGeometry(adapter.render(emit(chain)))`.
// Computes the same `SvgGeometry` shape directly from the
// `PositionedValueChain` + `EmitOwmOptions`, without invoking
// cli-owm. Phase 6 of the verify-layout plan.
//
// This module exists because cli-owm is fully deterministic — circles
// at `(maturity × W, (1 - visibility) × H)`, labels at
// `(circle.x + dx, circle.y + dy)`, anchors as `text-anchor="middle"`
// at the same circle coordinates. So we can predict every pixel from
// the chain alone and skip the SVG render entirely. The vendor smoke
// test (`src/lib/vendor/cli-owm/__smoke.test.mts`) and the regression
// test (`analytical-geometry.test.mts`) jointly guarantee the
// analytical model stays faithful to cli-owm's output.
//
// Constants captured from `src/lib/vendor/cli-owm/render.mts:69-77`
// at commit `4950f330`. A future bump of the vendor will require
// re-validating the constants below.

import type {
  PositionedValueChain,
  PositionedComponent,
} from '../../types/value-chain.mjs';
import type { EmitOwmOptions } from '../../work-on-value-chain/write/chain/emit-owm.mjs';
import {
  LABEL_CHAR_WIDTH,
  LABEL_HEIGHT,
  COMPONENT_RADIUS,
  PHASE_AXIS_RATIOS,
  type Bbox,
  type EdgeSegment,
  type GeometryItem,
  type GeometryReport,
  type SvgGeometry,
  type Canvas,
} from './svg-bbox-parser.mjs';

// ─── Constants matching cli-owm 4950f330 ───────────────────────────────

/** Default visible map width when DSL omits `size [w, h]`. Matches
 *  cli-owm's `options?.width ?? 500`. */
export const DEFAULT_MAP_WIDTH = 500;
/** Default visible map height when DSL omits `size [w, h]`. */
export const DEFAULT_MAP_HEIGHT = 600;
/** SVG outer width = mapWidth + horizontal padding (35 left + 70
 *  right axis area). Matches cli-owm `svgWidth = width + 105`. */
export const SVG_PADDING_X = 105;
/** SVG outer height = mapHeight + vertical padding (45 top axis +
 *  92 bottom axis labels). Matches cli-owm `svgHeight = height + 137`. */
export const SVG_PADDING_Y = 137;

// ─── Coordinate helpers (mirror cli-owm:render.ts) ─────────────────────

function maturityToX(maturity: number, width: number): number {
  return maturity * width;
}

function visibilityToY(visibility: number, height: number): number {
  return (1 - visibility) * height;
}

// ─── Bbox builders (identical to svg-bbox-parser private helpers) ──────

function circleBbox(cx: number, cy: number, r: number): Bbox {
  return { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r };
}

function textBbox(x: number, y: number, anchor: string, content: string): Bbox {
  const width = Math.max(1, content.length) * LABEL_CHAR_WIDTH;
  const top = y - (LABEL_HEIGHT - 2);
  const left = anchor === 'middle' ? x - width / 2
             : anchor === 'end'    ? x - width
             : /* start */            x;
  return { x: left, y: top, width, height: LABEL_HEIGHT };
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Compute the SvgGeometry that cli-owm would produce for `chain`,
 * without actually invoking cli-owm. Output shape is byte-equivalent
 * to `parseSvgGeometry(adapter.render(generateChainOwmSyntax(chain,
 * emitOpts)))` modulo float-rounding noise (tolerance ≤ 1 px).
 *
 * Items are emitted in the chain.components order (anchors and
 * components interleaved). The downstream overlap detector is order-
 * agnostic.
 */
export function computeGeometry(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
): SvgGeometry {
  const mapWidth  = emitOpts.size?.width  ?? DEFAULT_MAP_WIDTH;
  const mapHeight = emitOpts.size?.height ?? DEFAULT_MAP_HEIGHT;

  const canvas: Canvas = {
    width:  mapWidth  + SVG_PADDING_X,
    height: mapHeight + SVG_PADDING_Y,
  };
  const mapArea: Bbox = { x: 0, y: 0, width: mapWidth, height: mapHeight };
  const phaseAxes = PHASE_AXIS_RATIOS.map(r => mapArea.x + r * mapArea.width);

  const items: GeometryReport = [];
  const positions = new Map<string, { cx: number; cy: number }>();

  for (const c of chain.components) {
    const cx = maturityToX(c.evolution,  mapWidth);
    const cy = visibilityToY(c.visibility, mapHeight);
    positions.set(c.name, { cx, cy });

    if (c.role === 'anchor') {
      // cli-owm renders anchors as `text-anchor="middle"` text at (cx, cy).
      items.push({
        name: c.name,
        kind: 'anchor',
        bbox: textBbox(cx, cy, 'middle', c.name),
      });
      continue;
    }

    // Components: circle + label. cli-owm's default label offset when
    // missing is (5, -10) but the chain pipeline always assigns one
    // via place-labels.mts.
    items.push({
      name: c.name,
      kind: 'component',
      bbox: circleBbox(cx, cy, COMPONENT_RADIUS),
    });
    const dx = c.label?.dx ?? 5;
    const dy = c.label?.dy ?? -10;
    items.push({
      name: c.name,
      kind: 'label',
      bbox: textBbox(cx + dx, cy + dy, 'start', c.name),
    });
  }

  const edges: EdgeSegment[] = [];
  for (const link of chain.links) {
    const from = positions.get(link.from);
    const to   = positions.get(link.to);
    if (!from || !to) continue;
    edges.push({
      from: link.from,
      to:   link.to,
      x1: from.cx, y1: from.cy,
      x2: to.cx,   y2: to.cy,
    });
  }

  return { items, edges, canvas, mapArea, phaseAxes };
}
