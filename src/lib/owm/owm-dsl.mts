// Shared catalog of OWM (onlinewardleymaps.com) DSL commands.
//
// Single source of truth for emitting OWM syntax across the codebase.
// Grammar mirrors the reference parsers in damonsk/onlinewardleymaps under
// frontend/src/conversion/*ExtractionStrategy.ts.
//
// Two surfaces:
//   1. Pure `emit*` helpers for composing OWM lines.
//   2. `OWM_DSL_REFERENCE` — a metadata catalog describing every command,
//      its syntax, and a usage example. Functions that produce OWM can pick
//      the subset of commands they need.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OwmCoords {
  visibility: number; // Y, [0, 1]
  evolution: number;  // X, [0, 1]
}

export interface OwmLabelOffset {
  dx: number;
  dy: number;
}

export interface OwmSize {
  width: number;
  height: number;
}

export type OwmStyle = 'plain' | 'wardley' | 'handwritten' | 'colour' | 'dark';

export type OwmLinkKind =
  | 'flow'           // A->B  (default flow)
  | 'no-flow'        // ?? not used in the parser; kept for completeness
  | 'flow-future'    // A+>B  (future)
  | 'flow-past'      // A+<B  (past)
  | 'flow-both'      // A+<>B (past + future)
  | 'flow-named';    // A+'label'>B etc.

// ─── Formatting primitives ──────────────────────────────────────────────────

/** Round to 2 decimals — OWM coordinates convention. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format a [vis, evo] coordinate pair. */
export function fmtCoords(c: OwmCoords): string {
  return `[${round2(c.visibility)}, ${round2(c.evolution)}]`;
}

/** Format a label [dx, dy] offset. */
export function fmtLabel(l: OwmLabelOffset): string {
  return `[${Math.round(l.dx)}, ${Math.round(l.dy)}]`;
}

/** Strip embedded double quotes — OWM has no escape syntax. */
export function safeName(name: string): string {
  return name.replace(/"/g, "'");
}

/** Maximum visible label length OWM accepts (rendered text, not counting
 *  surrounding quotes or escape sequences). */
export const MAX_LABEL_LENGTH = 500;

/** Word-count threshold above which a name is wrapped with quotes and
 *  broken into two lines via `\n`. Mirrors the user-observed convention. */
export const LINE_BREAK_WORD_THRESHOLD = 4;

export interface FormatNameOptions {
  /**
   * Force wrap+`\n` regardless of word count. Useful for callers that
   * already know they want the line break (e.g. titles read from layout).
   */
  forceLineBreak?: boolean;
  /**
   * Threshold override. Default = 4 (i.e. 5+ words trigger a break).
   */
  wordThreshold?: number;
}

/**
 * Format a component name for use in OWM declarations and links. The same
 * formatted output MUST be reused in both places (declaration line and
 * `A->B` lines) so the OWM parser can match them.
 *
 * Rules:
 *  - 0..N words ≤ threshold → bare name (multi-word names with spaces are
 *    valid OWM identifiers; the parser reads up to the trailing `[`).
 *  - words > threshold → wrap in double quotes and insert ` \n ` after
 *    the `Math.ceil(n/2)`-th word so the rendered label breaks cleanly.
 *  - Throws when the visible label would exceed MAX_LABEL_LENGTH.
 */
export function formatComponentName(name: string, opts: FormatNameOptions = {}): string {
  const cleaned = safeName(name).trim();
  if (cleaned.length === 0) return '"Component"';
  if (cleaned.length > MAX_LABEL_LENGTH) {
    throw new Error(
      `OWM label exceeds ${MAX_LABEL_LENGTH} characters (got ${cleaned.length}): ${cleaned.slice(0, 60)}…`,
    );
  }

  const words = cleaned.split(/\s+/);
  const threshold = opts.wordThreshold ?? LINE_BREAK_WORD_THRESHOLD;
  const shouldBreak = opts.forceLineBreak === true || words.length > threshold;

  if (!shouldBreak) return cleaned;

  const breakIdx = Math.ceil(words.length / 2);
  const head = words.slice(0, breakIdx).join(' ');
  const tail = words.slice(breakIdx).join(' ');
  return `"${head} \\n ${tail}"`;
}

// ─── Commands ───────────────────────────────────────────────────────────────

/** `title <text>` — first non-comment line idiomatically. */
export function emitTitle(text: string): string {
  return `title ${text.trim()}`;
}

/** `anchor <name> [vis, evo]` — stakeholder beneficiary. */
export function emitAnchor(name: string, coords: OwmCoords, label?: OwmLabelOffset): string {
  const base = `anchor ${formatComponentName(name)} ${fmtCoords(coords)}`;
  return label ? `${base} label ${fmtLabel(label)}` : base;
}

/** `component <name> [vis, evo] label [dx, dy]` */
export function emitComponent(
  name: string,
  coords: OwmCoords,
  label?: OwmLabelOffset,
): string {
  const base = `component ${formatComponentName(name)} ${fmtCoords(coords)}`;
  return label ? `${base} label ${fmtLabel(label)}` : base;
}

/** `market <name> [vis, evo] label [dx, dy]` */
export function emitMarket(
  name: string,
  coords: OwmCoords,
  label?: OwmLabelOffset,
): string {
  const base = `market ${formatComponentName(name)} ${fmtCoords(coords)}`;
  return label ? `${base} label ${fmtLabel(label)}` : base;
}

/** `ecosystem <name> [vis, evo] label [dx, dy]` */
export function emitEcosystem(
  name: string,
  coords: OwmCoords,
  label?: OwmLabelOffset,
): string {
  const base = `ecosystem ${formatComponentName(name)} ${fmtCoords(coords)}`;
  return label ? `${base} label ${fmtLabel(label)}` : base;
}

/** `pipeline <name> [evo_min, evo_max]` (one-line form). */
export function emitPipelineLine(name: string, evoMin: number, evoMax: number): string {
  return `pipeline ${formatComponentName(name)} [${round2(evoMin)}, ${round2(evoMax)}]`;
}

/**
 * `pipeline <name> { … }` block form. Inner lines should be `component …`
 * declarations produced separately and joined here.
 */
export function emitPipelineBlock(name: string, innerLines: readonly string[]): string {
  const opener = `pipeline ${formatComponentName(name)}`;
  const body = innerLines.map(l => `    ${l}`).join('\n');
  return `${opener}\n{\n${body}\n}`;
}

/** `evolve <name> <new_evo> label [dx, dy]` */
export function emitEvolve(
  name: string,
  newEvolution: number,
  label?: OwmLabelOffset,
): string {
  const base = `evolve ${formatComponentName(name)} ${round2(newEvolution)}`;
  return label ? `${base} label ${fmtLabel(label)}` : base;
}

/** `note <text> [vis, evo]` */
export function emitNote(text: string, coords: OwmCoords): string {
  return `note ${text} ${fmtCoords(coords)}`;
}

/** `annotation <num> [vis, evo] <text>` */
export function emitAnnotation(num: number, coords: OwmCoords, text: string): string {
  return `annotation ${num} ${fmtCoords(coords)} ${text}`;
}

/** `annotations [vis, evo]` — placement of the legend block. */
export function emitAnnotationsLegend(coords: OwmCoords): string {
  return `annotations ${fmtCoords(coords)}`;
}

/** `url <name> <link>` */
export function emitUrl(name: string, link: string): string {
  return `url ${safeName(name)} ${link}`;
}

/** `style <name>` */
export function emitStyle(style: OwmStyle): string {
  return `style ${style}`;
}

/** `size [w, h]` */
export function emitSize(size: OwmSize): string {
  return `size [${Math.round(size.width)}, ${Math.round(size.height)}]`;
}

/** `evolution <l1> -> <l2> -> <l3> -> <l4>` — X-axis labels. */
export function emitEvolutionAxis(labels: [string, string, string, string]): string {
  return `evolution ${labels.join(' -> ')}`;
}

/** `submap <name> [vis, evo] url(<ref>) label [dx, dy]` */
export function emitSubmap(
  name: string,
  coords: OwmCoords,
  urlRef: string,
  label?: OwmLabelOffset,
): string {
  const base = `submap ${safeName(name)} ${fmtCoords(coords)} url(${urlRef})`;
  return label ? `${base} label ${fmtLabel(label)}` : base;
}

/** `<method> <name>` — method = buy | build | outsource. */
export type OwmMethod = 'buy' | 'build' | 'outsource';
export function emitMethod(method: OwmMethod, name: string): string {
  return `${method} ${safeName(name)}`;
}

/** `pioneers/settlers/townplanners [vis, evo] [w, h]` */
export type OwmAttitude = 'pioneers' | 'settlers' | 'townplanners';
export function emitAttitude(
  kind: OwmAttitude,
  coords: OwmCoords,
  size: OwmSize,
): string {
  return `${kind} ${fmtCoords(coords)} [${Math.round(size.width)}, ${Math.round(size.height)}]`;
}

/** `accelerator <name> [vis, evo]` (or `deaccelerator`). */
export function emitAccelerator(
  name: string,
  coords: OwmCoords,
  decel: boolean = false,
): string {
  const kw = decel ? 'deaccelerator' : 'accelerator';
  return `${kw} ${safeName(name)} ${fmtCoords(coords)}`;
}

// ─── Links ───────────────────────────────────────────────────────────────────

/** Default flow link `A->B` (A consumes B). */
export function emitLink(from: string, to: string, context?: string): string {
  const base = `${formatComponentName(from)}->${formatComponentName(to)}`;
  return context ? `${base} ; ${context}` : base;
}

/** Future flow link `A+>B`. */
export function emitLinkFuture(from: string, to: string, context?: string): string {
  const base = `${formatComponentName(from)}+>${formatComponentName(to)}`;
  return context ? `${base} ; ${context}` : base;
}

/** Past flow link `A+<B`. */
export function emitLinkPast(from: string, to: string, context?: string): string {
  const base = `${formatComponentName(from)}+<${formatComponentName(to)}`;
  return context ? `${base} ; ${context}` : base;
}

/** Past + future flow link `A+<>B`. */
export function emitLinkBoth(from: string, to: string, context?: string): string {
  const base = `${formatComponentName(from)}+<>${formatComponentName(to)}`;
  return context ? `${base} ; ${context}` : base;
}

/** Named flow `A+'label'>B` (and variants). */
export function emitLinkNamed(
  from: string,
  to: string,
  label: string,
  variant: 'future' | 'past' | 'both' = 'future',
  context?: string,
): string {
  const arrow = variant === 'future' ? "'>" : variant === 'past' ? "'<" : "'<>";
  const base = `${formatComponentName(from)}+'${label}${arrow}${formatComponentName(to)}`;
  return context ? `${base} ; ${context}` : base;
}

/** OWM line-comment. */
export function emitComment(text: string): string {
  return `// ${text}`;
}

// ─── Reference catalog ──────────────────────────────────────────────────────
//
// Read-only metadata describing every command. Useful for documentation,
// LLM prompt enrichment, and exposing a "DSL palette" to higher-level
// generators.

export interface OwmDslEntry {
  /** Keyword in the OWM grammar. */
  keyword: string;
  /** Human-readable description. */
  description: string;
  /** Syntax template. */
  syntax: string;
  /** Concrete example line. */
  example: string;
  /** Source: which extraction strategy in the OWM repo handles this command. */
  parser: string;
}

export const OWM_DSL_REFERENCE: Readonly<Record<string, OwmDslEntry>> = Object.freeze({
  title: {
    keyword: 'title',
    description: 'Map title displayed at the top of the canvas.',
    syntax: 'title <text>',
    example: 'title Value chain of an online payment provider',
    parser: 'TitleExtractionStrategy',
  },
  anchor: {
    keyword: 'anchor',
    description: 'Stakeholder beneficiary at the root of the value chain. Rendered with anchor-specific styling.',
    syntax: 'anchor <name> [vis, evo]',
    example: 'anchor Merchant [0.95, 0.5]',
    parser: 'AnchorExtractionStrategy',
  },
  component: {
    keyword: 'component',
    description: 'Standard component (activity, practice, knowledge, data) with a 2D position and optional label offset.',
    syntax: 'component <name> [vis, evo] label [dx, dy]',
    example: 'component Payment Gateway [0.5, 0.6] label [-40, 5]',
    parser: 'ComponentExtractionStrategy',
  },
  pipeline: {
    keyword: 'pipeline',
    description: 'Wraps multiple components serving the same capability across evolution stages. One-line form pins the X range; block form `pipeline X { … }` lists inner components.',
    syntax: 'pipeline <name> [evo_min, evo_max]    OR    pipeline <name> { component … }',
    example: 'pipeline "Container Orchestration" [0.4, 0.78]',
    parser: 'PipelineExtractionStrategy',
  },
  evolve: {
    keyword: 'evolve',
    description: 'Evolution trajectory of a component over time — emits an arrow on the map.',
    syntax: 'evolve <name> <new_evolution> label [dx, dy]',
    example: 'evolve Kubernetes 0.85 label [10, 5]',
    parser: 'EvolveExtractionStrategy',
  },
  market: {
    keyword: 'market',
    description: 'Competitive crossroad where multiple providers compete.',
    syntax: 'market <name> [vis, evo] label [dx, dy]',
    example: 'market Cloud [0.4, 0.7] label [10, 5]',
    parser: 'MarketExtractionStrategy',
  },
  ecosystem: {
    keyword: 'ecosystem',
    description: 'Interconnected system of components — rendered with ecosystem styling.',
    syntax: 'ecosystem <name> [vis, evo] label [dx, dy]',
    example: 'ecosystem AppStore [0.6, 0.65]',
    parser: 'EcosystemExtractionStrategy',
  },
  submap: {
    keyword: 'submap',
    description: 'Reference to another map embedded as a node.',
    syntax: 'submap <name> [vis, evo] url(<ref>) label [dx, dy]',
    example: 'submap Logistics [0.5, 0.5] url(https://...)',
    parser: 'SubMapExtractionStrategy',
  },
  note: {
    keyword: 'note',
    description: 'Free-text annotation placed on the canvas.',
    syntax: 'note <text> [vis, evo]',
    example: 'note "key insight here" [0.2, 0.6]',
    parser: 'NoteExtractionStrategy',
  },
  annotation: {
    keyword: 'annotation',
    description: 'Numbered annotation referenced from a legend; pair with `annotations [vis, evo]` to position the legend.',
    syntax: 'annotation <num> [vis, evo] <text>',
    example: 'annotation 1 [0.5, 0.4] First milestone',
    parser: 'AnnotationExtractionStrategy',
  },
  url: {
    keyword: 'url',
    description: 'Hyperlink attached to a named resource. Used by submap, etc.',
    syntax: 'url <name> <link>',
    example: 'url logistics https://example.com/logistics',
    parser: 'UrlExtractionStrategy',
  },
  style: {
    keyword: 'style',
    description: 'Map rendering style. One of: plain | wardley | handwritten | colour | dark.',
    syntax: 'style <name>',
    example: 'style plain',
    parser: 'PresentationExtractionStrategy',
  },
  size: {
    keyword: 'size',
    description: 'Canvas dimensions in pixels.',
    syntax: 'size [w, h]',
    example: 'size [1200, 800]',
    parser: 'PresentationExtractionStrategy',
  },
  evolution: {
    keyword: 'evolution',
    description: 'X-axis labels (4 phases). Default OWM labels: Genesis -> Custom-Built -> Product -> Commodity.',
    syntax: 'evolution <l1> -> <l2> -> <l3> -> <l4>',
    example: 'evolution Genesis -> Custom-Built -> Product -> Commodity',
    parser: 'XAxisLabelsExtractionStrategy',
  },
  method: {
    keyword: 'buy|build|outsource',
    description: 'Sourcing method marker on a component.',
    syntax: '<method> <name>',
    example: 'buy "Card Network Access"',
    parser: 'MethodExtractionStrategy',
  },
  attitude: {
    keyword: 'pioneers|settlers|townplanners',
    description: 'Pioneers/Settlers/Townplanners (PST) zones drawn on the canvas.',
    syntax: '<attitude> [vis, evo] [w, h]',
    example: 'pioneers [0.9, 0.2] [0.2, 0.2]',
    parser: 'AttitudeExtractionStrategy',
  },
  accelerator: {
    keyword: 'accelerator|deaccelerator',
    description: 'Tempo marker indicating where adoption accelerates or stalls.',
    syntax: 'accelerator <name> [vis, evo]',
    example: 'accelerator AI [0.5, 0.6]',
    parser: 'AcceleratorExtractionStrategy',
  },
  link: {
    keyword: 'A->B',
    description: 'Default flow link from A to B. A consumes B (A is positioned higher in visibility). Variants: `+>` future, `+<` past, `+<>` both, `+\'label\'>` named flow. Trailing `; <text>` adds context.',
    syntax: '<from>-><to>    OR    <from>+><to>    etc.',
    example: 'Merchant->Payment Gateway',
    parser: 'LinksExtractionStrategy',
  },
  comment: {
    keyword: '//',
    description: 'Line comment ignored by the parser.',
    syntax: '// <text>',
    example: '// scope: payment processing',
    parser: '(none)',
  },
});

/** Default OWM evolution-axis labels (matches the OWM parser's defaults). */
export const DEFAULT_EVOLUTION_LABELS: readonly [string, string, string, string] = [
  'Genesis',
  'Custom-Built',
  'Product',
  'Commodity',
];