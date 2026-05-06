// Extract approximate bounding boxes from a cli-owm-rendered SVG so the
// chain pipeline (`verify-layout`) can run collision detection in pixel
// space.
//
// The parser is deliberately tightly-scoped to the SVG shape that
// cli-owm emits today (verified by inspection 2026-05-06). It does NOT
// aim for general SVG support — that is a non-goal. The contract is:
// "given a cli-owm SVG and the set of known component names, return
// bboxes for every component, label and anchor we recognise; plus the
// dependency edges and the canvas dimensions". Any decoration (axes,
// title, gradient stops, dash patterns) is filtered out by name
// matching: anything whose `<text>` content is not in `knownNames` is
// ignored. This is more robust than heuristic geometry filtering
// because chain titles or future axis labels cannot accidentally creep
// in.
//
// Text bbox estimation uses a constant char-width approximation
// (`LABEL_CHAR_WIDTH = 7px` at the cli-owm default 14px font), which
// over-estimates narrow glyphs (`i`, `l`, `.`) and under-estimates
// wide ones (`m`, `w`). The over-estimation bias is intentional: a
// false-positive collision is worth less correction work than a
// false-negative that lets two labels overlap in the rendered map.
// Future work could bind `node-canvas` or `opentype.js` to measure
// glyphs against the actual font without changing this module's
// public API.

/** Pixel-space rectangle, axis-aligned. (x, y) is the top-left corner. */
export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GeometryKind = 'component' | 'label' | 'anchor';

export interface GeometryItem {
  name: string;
  kind: GeometryKind;
  bbox: Bbox;
}

export type GeometryReport = GeometryItem[];

/** A dependency line `from`→`to` rendered as a `<line>` between the
 *  centres of the two components. Endpoints are matched by coordinate
 *  to known component circles (or anchor text positions). */
export interface EdgeSegment {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Outer canvas dimensions of the SVG (root `<svg width height>`). When
 *  the renderer omits these attributes, both fields are 0 and callers
 *  should treat canvas-overflow as undecidable. */
export interface Canvas {
  width: number;
  height: number;
}

/** Aggregate geometry returned by `parseSvgGeometry`. */
export interface SvgGeometry {
  items: GeometryReport;
  edges: EdgeSegment[];
  canvas: Canvas;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Approximate pixel width of one character at the cli-owm default 14px
 *  font (Helvetica Neue / Arial). Empirical, slightly over-estimates. */
export const LABEL_CHAR_WIDTH = 7;
/** Approximate text bbox height — cap height + descent at 14px font. */
export const LABEL_HEIGHT = 16;
/** Default `r` attribute used by cli-owm for component circles. */
export const COMPONENT_RADIUS = 5;
/** Tolerance (px) used when matching `<line>` endpoints to known
 *  component centres. cli-owm emits coordinates with floating-point
 *  rounding noise (e.g. `30.00000000000003`), so an exact match would
 *  miss legitimate edges. */
export const ENDPOINT_MATCH_TOLERANCE = 0.5;

// ─── SVG slicing ────────────────────────────────────────────────────────

/** Strip out every `<g id="valueChain">…</g>`, `<g id="Evolution">…</g>`
 *  and `<defs>…</defs>` block. These groups only contain axis
 *  decorations and gradient definitions — never component content. */
function stripDecorationGroups(svg: string): string {
  const blockRegexes = [
    /<defs\b[\s\S]*?<\/defs>/g,
    /<g\s+id="valueChain"[^>]*>[\s\S]*?<\/g>/g,
    /<g\s+id="Evolution"[^>]*>[\s\S]*?<\/g>/g,
  ];
  return blockRegexes.reduce((acc, rx) => acc.replace(rx, ''), svg);
}

// ─── Token regexes ─────────────────────────────────────────────────────

const CIRCLE_RX = /<circle\s+([^>/]+)\/?>/g;
const TEXT_RX = /<text\s+([^>]+)>([\s\S]*?)<\/text>/g;
const LINE_RX = /<line\s+([^>/]+)\/?>/g;
const ATTR_RX = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;

function readAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RX.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function num(s: string | undefined): number {
  if (s === undefined) return NaN;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function decodeText(raw: string): string {
  // cli-owm emits straight ASCII content for component names; honour
  // the small set of XML entities we might encounter in user-supplied
  // names.
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ─── Bbox builders ─────────────────────────────────────────────────────

function circleBbox(cx: number, cy: number, r: number): Bbox {
  return { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r };
}

function textBbox(x: number, y: number, anchor: string, content: string): Bbox {
  const width = Math.max(1, content.length) * LABEL_CHAR_WIDTH;
  // SVG `<text>` `y` is the baseline; the visual top is roughly one
  // line-height above. We give a 2px descent below the baseline so
  // the bbox covers descenders of glyphs like `g`, `p`, `y`.
  const top = y - (LABEL_HEIGHT - 2);
  const left = anchor === 'middle' ? x - width / 2
             : anchor === 'end'    ? x - width
             : /* start */            x;
  return { x: left, y: top, width, height: LABEL_HEIGHT };
}

// ─── Canvas + edges + items extraction ─────────────────────────────────

function extractCanvas(svg: string): Canvas {
  // Read width/height from the root `<svg ...>` opening tag only —
  // any nested `<svg>` (rare, but safe to ignore) wouldn't be the
  // canvas reference.
  const closeIdx = svg.indexOf('>');
  if (closeIdx < 0) return { width: 0, height: 0 };
  const head = svg.slice(0, closeIdx + 1);
  const w = head.match(/\bwidth="([^"]+)"/);
  const h = head.match(/\bheight="([^"]+)"/);
  return {
    width:  w ? Math.max(0, num(w[1]) || 0) : 0,
    height: h ? Math.max(0, num(h[1]) || 0) : 0,
  };
}

interface PositionedName {
  name: string;
  x: number;
  y: number;
}

interface ItemsAndPositions {
  items: GeometryReport;
  /** Endpoint-matching index : every component's circle centre and
   *  every anchor's text position, keyed by name. Used to resolve
   *  `<line>` endpoints back to component names. */
  positions: PositionedName[];
}

/** Walk `<circle>` and `<text>` tokens in document order and pair each
 *  circle with its following matching label. Anchors are emitted
 *  directly from middle-anchored `<text>` tokens. Also records the
 *  endpoint position for each named component/anchor so edges can be
 *  resolved later. */
function parseItemsAndPositions(
  svg: string,
  knownNames: ReadonlySet<string>,
): ItemsAndPositions {
  const stripped = stripDecorationGroups(svg);
  const items: GeometryReport = [];
  const positions: PositionedName[] = [];

  CIRCLE_RX.lastIndex = 0;
  TEXT_RX.lastIndex = 0;
  let circleMatch = CIRCLE_RX.exec(stripped);
  let textMatch = TEXT_RX.exec(stripped);
  let pendingCircle: { cx: number; cy: number; r: number; index: number } | null = null;

  while (circleMatch !== null || textMatch !== null) {
    const useCircle =
      textMatch === null ||
      (circleMatch !== null && circleMatch.index < textMatch.index);

    if (useCircle && circleMatch !== null) {
      const attrs = readAttrs(circleMatch[1]);
      const cx = num(attrs.cx), cy = num(attrs.cy), r = num(attrs.r);
      if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(r)) {
        pendingCircle = { cx, cy, r, index: circleMatch.index };
      }
      circleMatch = CIRCLE_RX.exec(stripped);
      continue;
    }

    if (textMatch !== null) {
      const attrs = readAttrs(textMatch[1]);
      const x = num(attrs.x), y = num(attrs.y);
      const anchor = attrs['text-anchor'] ?? 'start';
      const name = decodeText(textMatch[2]).trim();

      if (knownNames.has(name) && Number.isFinite(x) && Number.isFinite(y)) {
        const lbl = textBbox(x, y, anchor, name);
        if (anchor === 'middle') {
          items.push({ name, kind: 'anchor', bbox: lbl });
          positions.push({ name, x, y });
          pendingCircle = null;
        } else if (pendingCircle !== null) {
          items.push({ name, kind: 'component', bbox: circleBbox(pendingCircle.cx, pendingCircle.cy, pendingCircle.r) });
          items.push({ name, kind: 'label', bbox: lbl });
          positions.push({ name, x: pendingCircle.cx, y: pendingCircle.cy });
          pendingCircle = null;
        }
        // else: orphan text — silently drop (decoration we don't recognise)
      }
      textMatch = TEXT_RX.exec(stripped);
    }
  }

  return { items, positions };
}

function matchEndpoint(x: number, y: number, positions: readonly PositionedName[]): string | null {
  for (const p of positions) {
    if (Math.abs(p.x - x) < ENDPOINT_MATCH_TOLERANCE
     && Math.abs(p.y - y) < ENDPOINT_MATCH_TOLERANCE) {
      return p.name;
    }
  }
  return null;
}

/** Extract `<line>` elements at the top level (decoration groups are
 *  already stripped) and resolve each endpoint to a component name via
 *  `positions`. Lines whose endpoints don't match any known
 *  component are silently dropped — cli-owm sometimes emits ancillary
 *  lines (accelerator markers, baselines) that look like edges but
 *  don't connect named nodes. */
function extractEdges(svg: string, positions: readonly PositionedName[]): EdgeSegment[] {
  const stripped = stripDecorationGroups(svg);
  const out: EdgeSegment[] = [];

  LINE_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINE_RX.exec(stripped)) !== null) {
    const a = readAttrs(m[1]);
    const x1 = num(a.x1), y1 = num(a.y1), x2 = num(a.x2), y2 = num(a.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const from = matchEndpoint(x1, y1, positions);
    const to   = matchEndpoint(x2, y2, positions);
    if (from !== null && to !== null && from !== to) {
      out.push({ from, to, x1, y1, x2, y2 });
    }
  }
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Parse a cli-owm SVG into a flat geometry report plus its edges and
 * canvas dimensions. Only elements whose text content is in
 * `knownNames` survive the filter — this is by design (see file-level
 * comment).
 */
export function parseSvgGeometry(
  svg: string,
  knownNames: ReadonlySet<string>,
): SvgGeometry {
  const canvas = extractCanvas(svg);
  const { items, positions } = parseItemsAndPositions(svg, knownNames);
  const edges = extractEdges(svg, positions);
  return { items, edges, canvas };
}

/**
 * Backward-compatible alias for the V2 API. Equivalent to
 * `parseSvgGeometry(...).items`. Existing callers that only need
 * rect-rect collision detection keep working unchanged.
 */
export function parseSvgToBboxes(
  svg: string,
  knownNames: ReadonlySet<string>,
): GeometryReport {
  return parseSvgGeometry(svg, knownNames).items;
}
