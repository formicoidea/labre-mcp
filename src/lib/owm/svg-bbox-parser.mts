// Extract approximate bounding boxes from a cli-owm-rendered SVG so the
// chain pipeline (`verify-layout`) can run collision detection in pixel
// space.
//
// The parser is deliberately tightly-scoped to the SVG shape that
// cli-owm emits today (verified by inspection 2026-05-06). It does NOT
// aim for general SVG support — that is a non-goal. The contract is:
// "given a cli-owm SVG and the set of known component names, return
// bboxes for every component, label and anchor we recognise". Any
// decoration (axes, title, gradient stops, dash patterns) is filtered
// out by name matching: anything whose `<text>` content is not in
// `knownNames` is ignored. This is more robust than heuristic
// geometry filtering because chain titles or future axis labels
// cannot accidentally creep in.
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

// ─── Constants ──────────────────────────────────────────────────────────

/** Approximate pixel width of one character at the cli-owm default 14px
 *  font (Helvetica Neue / Arial). Empirical, slightly over-estimates. */
export const LABEL_CHAR_WIDTH = 7;
/** Approximate text bbox height — cap height + descent at 14px font. */
export const LABEL_HEIGHT = 16;
/** Default `r` attribute used by cli-owm for component circles. */
export const COMPONENT_RADIUS = 5;

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

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Parse a cli-owm SVG into a flat geometry report. Only elements whose
 * text content is in `knownNames` survive the filter — this is by
 * design (see file-level comment).
 *
 * Algorithm: top-level scan. A `<circle>` is buffered as the
 * "currently pending" component slot. The next `<text>` whose content
 * is in `knownNames` is associated with that pending circle; together
 * they emit a `component` bbox (from the circle) and a `label` bbox
 * (from the text). A `<text>` with `text-anchor="middle"` is emitted
 * as an `anchor` regardless of any pending circle (cli-owm renders
 * anchors as text-only nodes).
 *
 * Any unmatched circle is silently dropped (cli-owm does occasionally
 * emit decorative circles that have no labelled meaning, such as the
 * accelerator marker dots).
 */
export function parseSvgToBboxes(
  svg: string,
  knownNames: ReadonlySet<string>,
): GeometryReport {
  const stripped = stripDecorationGroups(svg);
  const out: GeometryReport = [];

  // Walk both regexes in document order using their lastIndex.
  CIRCLE_RX.lastIndex = 0;
  TEXT_RX.lastIndex = 0;
  let circleMatch = CIRCLE_RX.exec(stripped);
  let textMatch = TEXT_RX.exec(stripped);
  let pendingCircle: { cx: number; cy: number; r: number; index: number } | null = null;

  // Fold-merge the two streams by their lastIndex so we visit elements
  // in document order.
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
          out.push({ name, kind: 'anchor', bbox: lbl });
          pendingCircle = null;
        } else if (pendingCircle !== null) {
          out.push({ name, kind: 'component', bbox: circleBbox(pendingCircle.cx, pendingCircle.cy, pendingCircle.r) });
          out.push({ name, kind: 'label', bbox: lbl });
          pendingCircle = null;
        }
        // else: orphan text — silently drop (decoration we don't recognise)
      }
      textMatch = TEXT_RX.exec(stripped);
    }
  }

  return out;
}
