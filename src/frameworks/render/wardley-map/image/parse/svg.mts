// Real strategy `render:wardley-map:image:parse:svg`.
//
// Inverse of `render:wardley-map:image:emit:svg`: consumes an SVG produced by
// our renderer (`@formicoidea/wardley-map-renderer`) and reconstructs the
// canonical WardleyMap it was rendered from. Fully deterministic — no LLM, no
// DOM library, no new dependency: the SVG is sliced by regex/string exactly
// like `#lib/owm/svg-bbox-parser.mjs` does for cli-owm output.
//
// This is brick #1 of the "dataset by round-trip" opportunity: the quality
// oracle is idempotence, `emit → parse → compare`.
//
// ── DOM contract we rely on ────────────────────────────────────────────
//
// The renderer's `composeSVG` joins every fragment with "\n", and wraps each
// layer in a `<g data-layer="NAME">` group opened and closed on its own line
// (render/svg-composer.ts). One layer fragment == one line. That gives us a
// reliable, cheap slicing scheme:
//
//   <svg width=".." height=".." viewBox="..">   ← canvas dimensions
//   <g data-layer="title">  <text …>Title</text>
//   <g data-layer="axes">   two `marker-end="url(#axis-arrow)"` axis lines
//                           spanning exactly the plot area
//   <g data-layer="edges">  one `<line x1 y1 x2 y2>` per relation, from the
//                           CONSUMER centre (x1,y1) to the SUPPLIER centre
//                           (x2,y2), coloured by relation type
//   <g data-layer="nodes">  one fragment per renderable component, IN MAP
//                           ORDER; the component's own circle is the first
//                           `<circle>` outside any `<defs>` block
//   <g data-layer="labels"> one `<text>` per labelled component, IN THE SAME
//                           MAP ORDER (render/labels-layer.ts and
//                           render/nodes-layer.ts both walk `ctx.nodes`)
//
// Identity markers the renderer leaks, and that we reuse when present:
//   - `data-component-id="…"`      (interactive renders)
//   - `id="anchor-clip-<id>"`      (anchor person silhouette clip path)
//   - `id="eco-hatch-<id>"`        (ecosystem hatch pattern)
// Plain `component` nodes carry NO id, so their id is re-derived by slugifying
// the label exactly like `buildIdMap` in `../../acl/value-chain.mts`.
//
// ── Geometry inversion ─────────────────────────────────────────────────
//
// Pixel → normalised scalars are recovered by ASKING THE RENDERER, never by
// guessing margins: `computeMapGeometry` on an empty calibration map sized to
// the parsed canvas exposes `evoToX` / `visToY`, which are affine, so two
// probes (0 and 1) fully determine the inverse. When the source SVG still has
// its axes, we prefer the axis lines — they are what was ACTUALLY rendered and
// therefore survive a renderer version whose margins changed since.
//
// ── Known limitations (reported as warnings, never as a crash) ─────────
//   - pipelines, evolvesTo arrows, steps, accelerators, notes and flow labels
//     are not reconstructed; their layer is reported as ignored.
//   - relation ids are not present in a non-interactive SVG; they are
//     regenerated as `rel-1…rel-N` in edge order.
//   - `label.position` (dx/dy) is NOT recovered: collision avoidance moves
//     unpinned labels, so an offset read back from the SVG would silently pin
//     every label on the next render. Labels re-emit at renderer defaults.
//   - `user-need` renders exactly like `component`, and `market`/`ecosystem`
//     subtypes are ambiguous with their same-named types — everything that is
//     not a detectable anchor is parsed as `component`.
//   - a non-default `coordinateSpace` (evolution/visibility display ranges) is
//     not encoded in the SVG; scalars are read back in the default [0,1] span.

import { z } from 'zod';
import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { computeMapGeometry } from '@formicoidea/wardley-map-renderer';
import { uniqueSlug } from '#lib/owm/canonical-ids.mjs';

const METHOD_ID = 'render:wardley-map:image:parse:svg';

/** Local input contract — the strategy only needs the SVG document itself. */
const ParseSvgInputSchema = z.object({ svg: z.string().min(1) });

export interface RenderWardleyMapImageParseSvgResult {
  /** Canonical map, or null when the SVG could not be recognised. */
  map: WardleyMap | null;
  parsed: boolean;
  /** Human-readable notes about everything dropped or approximated. */
  warnings: string[];
}

// ── Constants derived from the renderer's own source ───────────────────

/** Layers this parser understands. Any other non-empty layer is reported. */
const KNOWN_LAYERS: ReadonlySet<string> = new Set([
  'title',
  'axes',
  'edges',
  'nodes',
  'labels',
  'legend',
]);

/**
 * Edge stroke colour → relation type, mirroring `RELATION_TYPE_STYLES` in the
 * renderer's `render/svg-primitives.ts`. Those colours are hardcoded renderer
 * constants (NOT themeable through renderConfig) but are not re-exported by
 * the package entry point, so we mirror them here. Anything else falls back to
 * the schema default, `DependsOn`.
 */
const RELATION_TYPE_BY_STROKE: ReadonlyMap<string, 'DependsOn' | 'Flow' | 'Constraint'> = new Map([
  ['#999999', 'DependsOn'],
  ['#2563eb', 'Flow'],
  ['#dc2626', 'Constraint'],
]);

/** Max pixel distance for matching an edge endpoint to a node centre. */
const ENDPOINT_MATCH_TOLERANCE = 0.5;

/** Max pixel divergence tolerated between calibrated and rendered axes. */
const AXES_MATCH_TOLERANCE = 0.5;

/** Decimals kept on recovered scalars — kills float noise, far below the ε we promise. */
const SCALAR_DECIMALS = 6;

// ── Low-level SVG token helpers (regex/string only, no DOM) ────────────

const ATTR_RX = /([\w-]+)\s*=\s*"([^"]*)"/g;
const CIRCLE_RX = /<circle\s+([^>]*?)\/>/g;
const LINE_RX = /<line\s+([^>]*?)\/>/g;
const TEXT_RX = /<text\s+([^>]*?)>([\s\S]*?)<\/text>/g;
const DEFS_RX = /<defs\b[\s\S]*?<\/defs>/g;
const LAYER_OPEN_RX = /^<g\s+data-layer="([^"]+)">$/;

function readAttrs(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RX.exec(fragment)) !== null) out[m[1]] = m[2];
  return out;
}

function num(raw: string | undefined): number {
  if (raw === undefined) return Number.NaN;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Inverse of the renderer's `esc()` (render/svg-primitives.ts). */
function decodeXml(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Read the text content of a `<text>` element. Multi-line labels are emitted
 * as `First<tspan …>Second</tspan>`; restore the original "\n" separators.
 */
function textContent(inner: string): string {
  return decodeXml(inner.replace(/<tspan\b[^>]*>/g, '\n').replace(/<\/tspan>/g, ''));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function roundScalar(v: number): number {
  const f = 10 ** SCALAR_DECIMALS;
  return Math.round(clamp01(v) * f) / f;
}

// ── Layer slicing ──────────────────────────────────────────────────────

/**
 * Split the document into `layerName → fragment lines`. Relies on the composer
 * emitting `<g data-layer="X">` and its `</g>` on dedicated lines; every line
 * in between is one layer fragment (a fragment never contains a bare `</g>`
 * line of its own — nested groups are always inline).
 */
function sliceLayers(svg: string): Map<string, string[]> {
  const layers = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of svg.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (current === null) {
      const open = LAYER_OPEN_RX.exec(line);
      if (open !== null) {
        current = [];
        layers.set(open[1], current);
      }
      continue;
    }
    if (line === '</g>') {
      current = null;
      continue;
    }
    current.push(line);
  }
  return layers;
}

// ── Geometry inversion ─────────────────────────────────────────────────

/** The affine inverse of the renderer projection, in probe form. */
interface Projection {
  /** Pixel x of evolution 0 and 1. */
  x0: number;
  x1: number;
  /** Pixel y of visibility 0 and 1. */
  y0: number;
  y1: number;
}

/**
 * Empty map used to interrogate the renderer's own projection. It carries no
 * component, so `computeMapGeometry` only resolves margins + plot area, which
 * is exactly the coordinate system we need to invert. Parsed once at module
 * load: the shape never changes, only the canvas size passed per call.
 */
const CALIBRATION_MAP: WardleyMap = WardleyMapSchema.parse({
  title: '',
  components: [],
  relations: [],
});

/** `${width}x${height}` → projection. Calibration is pure, so caching is safe. */
const projectionCache = new Map<string, Projection>();

/**
 * Ask the renderer where evolution 0/1 and visibility 0/1 land on a canvas of
 * the given size. `evoToX` / `visToY` are affine, so probing both ends fully
 * determines the inverse — no margin constant is ever hardcoded here.
 */
function calibrateProjection(width: number, height: number): Projection {
  const key = `${width}x${height}`;
  const cached = projectionCache.get(key);
  if (cached !== undefined) return cached;
  const ctx = computeMapGeometry(CALIBRATION_MAP, { width, height });
  const projection: Projection = {
    x0: ctx.evoToX(0),
    x1: ctx.evoToX(1),
    y0: ctx.visToY(0),
    y1: ctx.visToY(1),
  };
  projectionCache.set(key, projection);
  return projection;
}

/**
 * Recover the projection from the two arrow-headed axis lines the axes layer
 * draws along the plot border: the horizontal one spans (plotLeft, plotBottom)
 * → (plotRight, plotBottom), the vertical one (plotLeft, plotBottom) →
 * (plotLeft, plotTop). Returns null when axes were not rendered.
 */
function projectionFromAxes(axesLines: readonly string[]): Projection | null {
  let left = Number.NaN;
  let right = Number.NaN;
  let top = Number.NaN;
  let bottom = Number.NaN;
  for (const fragment of axesLines) {
    if (!fragment.includes('marker-end=')) continue;
    const a = readAttrs(fragment);
    const x1 = num(a.x1);
    const y1 = num(a.y1);
    const x2 = num(a.x2);
    const y2 = num(a.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    if (y1 === y2) {
      left = Math.min(x1, x2);
      right = Math.max(x1, x2);
      bottom = y1;
    } else if (x1 === x2) {
      left = x1;
      top = Math.min(y1, y2);
      bottom = Math.max(y1, y2);
    }
  }
  if (![left, right, top, bottom].every(Number.isFinite)) return null;
  if (right === left || bottom === top) return null;
  return { x0: left, x1: right, y0: top, y1: bottom };
}

// ── Node / label / edge extraction ─────────────────────────────────────

type ParsedNodeType = 'component' | 'anchor';

interface ParsedNode {
  cx: number;
  cy: number;
  type: ParsedNodeType;
  /** Id leaked by the SVG, when the renderer emitted one. */
  id?: string;
  /** Symbol we recognised but cannot faithfully round-trip. */
  exoticSymbol?: 'ecosystem' | 'market';
}

/**
 * Parse one `nodes` layer fragment. The component's circle is the first
 * `<circle>` left after removing `<defs>` blocks (clip paths, hatch patterns),
 * because every symbol renderer emits its main circle before its decorations —
 * or right after its `<defs>` for ecosystem. Fragments with no circle (pipeline
 * handle squares) yield null.
 */
function parseNodeFragment(fragment: string): ParsedNode | null {
  const interactiveId = /data-component-id="([^"]+)"/.exec(fragment);
  const anchorId = /id="anchor-clip-([^"]+)"/.exec(fragment);
  const ecosystemId = /id="eco-hatch-([^"]+)"/.exec(fragment);

  const body = fragment.replace(DEFS_RX, '');
  CIRCLE_RX.lastIndex = 0;
  const circle = CIRCLE_RX.exec(body);
  if (circle === null) return null;
  const a = readAttrs(circle[1]);
  const cx = num(a.cx);
  const cy = num(a.cy);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

  const id = interactiveId?.[1] ?? anchorId?.[1] ?? ecosystemId?.[1];
  const exoticSymbol =
    ecosystemId !== null ? 'ecosystem' : body.includes('<polygon') ? 'market' : undefined;

  return {
    cx,
    cy,
    type: anchorId !== null ? 'anchor' : 'component',
    ...(id !== undefined ? { id } : {}),
    ...(exoticSymbol !== undefined ? { exoticSymbol } : {}),
  };
}

interface ParsedLabel {
  text: string;
  x: number;
  y: number;
}

function parseLabelFragment(fragment: string): ParsedLabel | null {
  TEXT_RX.lastIndex = 0;
  const m = TEXT_RX.exec(fragment);
  if (m === null) return null;
  const a = readAttrs(m[1]);
  const x = num(a.x);
  const y = num(a.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { text: textContent(m[2]), x, y };
}

/**
 * Drop a decoration circle drawn concentrically just before the node it
 * decorates (method indicator aura, emitted on its own line by
 * `renderComponentNode`). Returns the surviving nodes and how many were merged.
 */
function mergeConcentricDecorations(nodes: readonly ParsedNode[]): {
  nodes: ParsedNode[];
  merged: number;
} {
  const out: ParsedNode[] = [];
  let merged = 0;
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.cx === node.cx && prev.cy === node.cy) {
      out[out.length - 1] = node;
      merged += 1;
      continue;
    }
    out.push(node);
  }
  return { nodes: out, merged };
}

/** Index of the node whose centre is closest to (x, y), within tolerance. */
function nearestNode(x: number, y: number, nodes: readonly ParsedNode[]): number {
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < nodes.length; i += 1) {
    const dx = nodes[i].cx - x;
    const dy = nodes[i].cy - y;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return bestDist <= ENDPOINT_MATCH_TOLERANCE ? best : -1;
}

/** Same as `nearestNode` but unbounded — used as the label pairing fallback. */
function nearestNodeUnbounded(x: number, y: number, nodes: readonly ParsedNode[]): number {
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < nodes.length; i += 1) {
    const dist = Math.hypot(nodes[i].cx - x, nodes[i].cy - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// ── The parse itself ───────────────────────────────────────────────────

interface ParseOutcome {
  map: WardleyMap | null;
  warnings: string[];
}

function parseWardleySvg(svg: string): ParseOutcome {
  const warnings: string[] = [];

  const headEnd = svg.indexOf('>');
  if (!svg.includes('<svg') || headEnd < 0) {
    return { map: null, warnings: ['input is not an SVG document'] };
  }
  const head = readAttrs(svg.slice(0, headEnd + 1));
  const canvasWidth = num(head.width);
  const canvasHeight = num(head.height);
  if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight)) {
    return { map: null, warnings: ['root <svg> has no width/height: canvas size is unknown'] };
  }

  const layers = sliceLayers(svg);
  if (layers.size === 0) {
    return {
      map: null,
      warnings: ['no <g data-layer="…"> group found: not an SVG emitted by our renderer'],
    };
  }
  for (const [name, fragments] of layers) {
    if (!KNOWN_LAYERS.has(name) && fragments.length > 0) {
      warnings.push(`layer "${name}" is not parsed by this strategy: its content is dropped`);
    }
  }

  // Projection: calibrate against the current renderer, then prefer the axes
  // actually drawn in this document when they disagree (older renderer, custom
  // canvas) — they are the ground truth of what produced these pixels.
  let projection = calibrateProjection(canvasWidth, canvasHeight);
  const fromAxes = projectionFromAxes(layers.get('axes') ?? []);
  if (fromAxes !== null) {
    const drift = Math.max(
      Math.abs(fromAxes.x0 - projection.x0),
      Math.abs(fromAxes.x1 - projection.x1),
      Math.abs(fromAxes.y0 - projection.y0),
      Math.abs(fromAxes.y1 - projection.y1),
    );
    if (drift > AXES_MATCH_TOLERANCE) {
      warnings.push(
        `rendered axes differ from the calibration render by ${drift.toFixed(2)}px: ` +
          'using the axes as the coordinate reference',
      );
      projection = fromAxes;
    }
  }

  // Title.
  const titleFragments = layers.get('title') ?? [];
  const titleLabel = titleFragments.length > 0 ? parseLabelFragment(titleFragments[0]) : null;
  if (titleLabel === null) warnings.push('no title layer: title reconstructed as an empty string');

  // Nodes, in map order.
  const rawNodes: ParsedNode[] = [];
  for (const fragment of layers.get('nodes') ?? []) {
    const node = parseNodeFragment(fragment);
    if (node !== null) rawNodes.push(node);
  }
  const { nodes, merged } = mergeConcentricDecorations(rawNodes);
  if (merged > 0) {
    warnings.push(
      `${merged} concentric decoration(s) (method indicator?) merged into their node`,
    );
  }

  // Labels, in the same map order (both layers walk ctx.nodes).
  const labels: ParsedLabel[] = [];
  for (const fragment of layers.get('labels') ?? []) {
    const label = parseLabelFragment(fragment);
    if (label !== null) labels.push(label);
  }

  // Primary pairing is positional; fall back to proximity when the two layers
  // disagree (a pipeline is labelled but has no node circle, for instance).
  let labelForNode: Array<ParsedLabel | undefined>;
  if (labels.length === nodes.length) {
    labelForNode = labels;
  } else {
    warnings.push(
      `label/node count mismatch (${labels.length} labels for ${nodes.length} nodes): ` +
        'labels re-attached by proximity, which collision avoidance can defeat',
    );
    labelForNode = new Array<ParsedLabel | undefined>(nodes.length).fill(undefined);
    for (const label of labels) {
      const i = nearestNodeUnbounded(label.x, label.y, nodes);
      if (i >= 0 && labelForNode[i] === undefined) labelForNode[i] = label;
    }
  }

  // Ids: reuse what the SVG leaks, slugify the rest (shared canonical algorithm,
  // so a map produced by the value-chain ACL round-trips to the very same ids).
  const usedIds = new Set<string>();
  const components = nodes.map((node, i) => {
    const label = labelForNode[i];
    const name = label?.text ?? '';
    if (label === undefined) warnings.push(`node #${i} has no label: name left empty`);
    const id = node.id ?? uniqueSlug(name, usedIds);
    usedIds.add(id);
    if (node.exoticSymbol !== undefined) {
      warnings.push(
        `component "${id}" is drawn with the ${node.exoticSymbol} symbol: ` +
          'parsed as a plain component (subtype not recovered)',
      );
    }
    return {
      id,
      label: { name },
      type: node.type,
      position: {
        evolution: { scalar: roundScalar((node.cx - projection.x0) / (projection.x1 - projection.x0)) },
        visibility: { scalar: roundScalar((node.cy - projection.y0) / (projection.y1 - projection.y0)) },
      },
    };
  });

  // Relations: an edge runs consumer-centre → supplier-centre.
  const relations: Array<{ id: string; consumer: string; supplier: string; type?: string }> = [];
  let droppedEdges = 0;
  for (const fragment of layers.get('edges') ?? []) {
    LINE_RX.lastIndex = 0;
    const m = LINE_RX.exec(fragment);
    if (m === null) continue;
    const a = readAttrs(m[1]);
    const x1 = num(a.x1);
    const y1 = num(a.y1);
    const x2 = num(a.x2);
    const y2 = num(a.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const consumer = nearestNode(x1, y1, nodes);
    const supplier = nearestNode(x2, y2, nodes);
    if (consumer < 0 || supplier < 0 || consumer === supplier) {
      droppedEdges += 1;
      continue;
    }
    const type = RELATION_TYPE_BY_STROKE.get(a.stroke ?? '');
    relations.push({
      // Relation ids are absent from a non-interactive SVG — regenerated.
      id: `rel-${relations.length + 1}`,
      consumer: components[consumer].id,
      supplier: components[supplier].id,
      ...(type !== undefined ? { type } : {}),
    });
  }
  if (droppedEdges > 0) {
    warnings.push(`${droppedEdges} edge(s) had no matching node centre and were dropped`);
  }

  const candidate = {
    title: titleLabel?.text ?? '',
    components,
    relations,
  };
  const parsed = WardleyMapSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      map: null,
      warnings: [
        ...warnings,
        `reconstructed map is not schema-valid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      ],
    };
  }
  return { map: parsed.data, warnings };
}

// ── Strategy ───────────────────────────────────────────────────────────

export class RenderWardleyMapImageParseSvgStrategy extends BaseStrategy<
  // any: the strategy contract hands over an unvalidated envelope payload,
  // narrowed right below by ParseSvgInputSchema (same shape as emit:svg).
  unknown,
  RenderWardleyMapImageParseSvgResult
> {
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<RenderWardleyMapImageParseSvgResult>> {
    const capturedAt = new Date().toISOString();
    const validated = ParseSvgInputSchema.safeParse(input);

    if (!validated.success) {
      // Degradation-first: an upstream mock may hand us anything at all.
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: 'cannot parse: input is not { svg: string } (upstream step not yet promoted?)',
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: { map: null, parsed: false, warnings: ['input is not { svg: string }'] },
      };
    }

    const { map, warnings } = parseWardleySvg(validated.data.svg);

    const signals: StrategyResult<RenderWardleyMapImageParseSvgResult>['signals'] = [
      { name: 'input-valid', value: true, source: 'computed', capturedAt },
      { name: 'componentCount', value: map?.components.length ?? 0, source: 'computed', capturedAt },
      { name: 'relationCount', value: map?.relations.length ?? 0, source: 'computed', capturedAt },
    ];

    const insights: StrategyResult<RenderWardleyMapImageParseSvgResult>['insights'] = [];
    if (map === null) {
      insights.push({
        text: `cannot parse: ${warnings.join('; ')}`,
        by: METHOD_ID,
        type: 'other',
      });
    } else if (warnings.length > 0) {
      insights.push({
        text: `SVG partially parsed, ${warnings.length} construct(s) dropped or approximated: ${warnings.join('; ')}`,
        by: METHOD_ID,
        type: 'other',
      });
    }

    return {
      signals,
      reasoning: [],
      insights,
      result: { map, parsed: map !== null, warnings },
    };
  }
}
