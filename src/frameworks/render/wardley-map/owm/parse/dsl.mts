// Real strategy `render:wardley-map:owm:parse:dsl`.
//
// Reads an OWM (onlinewardleymaps.com) DSL source with the vendored cli-owm
// parser and projects it onto the canonical WardleyMap. Fully deterministic —
// no LLM, no I/O. Exact inverse of `render:wardley-map:owm:emit:dsl` on the
// subset that emitter produces (`title`, `anchor`, `component`, `A->B`).
//
// ROUND-TRIP CONTRACT (ast-schema.md, render domain § 2.3): `emit(parse(dsl))`
// is byte-identical for any DSL our emitter produced. That is why declaration
// order is restored by sorting on the source line (the vendored parser returns
// anchors and components in two separate buckets) and why a `label [dx, dy]`
// offset is only lifted when the SOURCE LINE actually carries one — the parser
// synthesises a default offset for every component, and adopting it would make
// the emitter add a `label` directive that was never written.
//
// Graceful by design (degradation-first): any OWM construction that has no home
// in the canonical schema is IGNORED and reported in `warnings`; the strategy
// never throws on a syntactically odd source. A non-string input degrades to
// `{ map: null, parsed: false }` plus an insight, like the emit/svg strategy.

import { z } from 'zod';
import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { parse as parseOwm, type UnifiedWardleyMap } from '#lib/vendor/cli-owm/index.mjs';

const METHOD_ID = 'render:wardley-map:owm:parse:dsl';

/** Local input contract — the DSL source, nothing else. */
const InputSchema = z.object({ dsl: z.string() });

export type RenderWardleyMapOwmParseDslInput = z.infer<typeof InputSchema>;

export interface RenderWardleyMapOwmParseDslResult {
  map: WardleyMap | null;
  parsed: boolean;
  warnings: string[];
}

/** One element as the vendored parser returns it (anchors and components alike). */
type OwmElement = UnifiedWardleyMap['components'][number];

// VISIBILITY CONVENTION — see the emit strategy's header: OWM puts 1 at the top
// of the value chain, the canonical schema puts 0 there. Self-inverse flip.
function flipVisibility(owmVisibility: number): number {
  const flipped = 1 - owmVisibility;
  return flipped < 0 ? 0 : flipped > 1 ? 1 : flipped;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Inverse of `formatComponentName` (#lib/owm/owm-dsl.mjs). The OWM parser keeps
 * the declaration spelling verbatim (setName only splits on ' ['), so a name our
 * emitter wrapped for line-breaking comes back as `"Head \n Tail"`, quotes and
 * literal `\n` marker included. Strip the wrapping quotes and fold the marker
 * back into a single space.
 */
function decodeComponentName(owmName: string): string {
  let name = owmName.trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1);
  }
  return name.replace(/\s*\\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Deterministic slug id, unique within the map (`-2`, `-3`, … on clash). */
function slugify(name: string): string {
  return (
    name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'node'
  );
}

// Keywords the vendored Converter has NO extraction strategy for — the lines are
// silently discarded (they even raise a parse error in LinksExtractionStrategy).
// Worth a warning: the caller's source carries intent we cannot represent.
const UNPARSED_KEYWORDS = ['market', 'ecosystem', 'buy', 'build', 'outsource'] as const;

/** Containers the parser fills but the canonical schema has no home for. */
const UNPROJECTED_CONTAINERS: ReadonlyArray<{ key: keyof UnifiedWardleyMap; label: string }> = [
  { key: 'pipelines', label: '`pipeline` declaration(s)' },
  { key: 'evolved', label: '`evolve` directive(s)' },
  { key: 'submaps', label: '`submap` declaration(s)' },
  { key: 'notes', label: '`note` declaration(s)' },
  { key: 'annotations', label: '`annotation` declaration(s)' },
  { key: 'urls', label: '`url` declaration(s)' },
  { key: 'attitudes', label: 'attitude zone(s) (pioneers/settlers/townplanners)' },
  { key: 'accelerators', label: '`accelerator`/`deaccelerator` marker(s)' },
  { key: 'evolution', label: 'custom evolution axis label(s)' },
];

/**
 * Pure projection OWM parse tree → canonical WardleyMap. Collects every ignored
 * construction in `warnings`; never throws on map content (only the final
 * WardleyMapSchema.parse can, and the caller guards it).
 */
function toCanonicalMap(owm: UnifiedWardleyMap, dsl: string, warnings: string[]): WardleyMap {
  const rawLines = dsl.split('\n');
  // `element.line` indexes the COMMENT-STRIPPED source. `//` stripping is
  // line-preserving, block comments are not — so only trust line numbers (used
  // to detect an explicit `label [dx, dy]`) when the source has no `/* … */`.
  const lineNumbersTrustworthy = !dsl.includes('/*');
  if (!lineNumbersTrustworthy) {
    warnings.push('source contains block comments; explicit `label [dx, dy]` offsets were not lifted');
  }

  // Restore declaration order: the parser splits anchors and components into two
  // buckets, and the emit ⇄ parse byte-identity depends on the original order.
  const elements: OwmElement[] = [...owm.anchors, ...owm.components].sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0),
  );

  const usedIds = new Set<string>();
  const idByOwmName = new Map<string, string>();
  const components = elements.map((el) => {
    const name = decodeComponentName(el.name ?? '');
    const base = slugify(name);
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);

    // Links reference components by their RAW (formatted) declaration spelling.
    if (idByOwmName.has(el.name)) {
      warnings.push(`duplicate component name "${el.name}"; links resolve to the first declaration`);
    } else {
      idByOwmName.set(el.name, id);
    }

    if (el.evolving === true) {
      warnings.push(`component "${name}": inline evolve target ignored (no canonical projection)`);
    }
    if (el.inertia === true) {
      warnings.push(`component "${name}": \`inertia\` marker ignored`);
    }

    const hasExplicitLabel =
      lineNumbersTrustworthy &&
      typeof el.line === 'number' &&
      (rawLines[el.line - 1] ?? '').includes('label [');

    return {
      id,
      label: {
        name,
        ...(hasExplicitLabel && el.label
          ? { position: { dx: el.label.x, dy: el.label.y } }
          : {}),
      },
      // OWM `submap` never reaches here (own bucket); anchors keep their type,
      // everything else lands on the generic canonical `component`.
      type: el.type === 'anchor' ? ('anchor' as const) : ('component' as const),
      position: {
        evolution: { scalar: clamp01(el.maturity) },
        visibility: { scalar: flipVisibility(clamp01(el.visibility)) },
      },
    };
  });

  const relations: Array<{ id: string; consumer: string; supplier: string }> = [];
  for (const link of owm.links) {
    // LinksExtractionStrategy only clears `flow` on the plain `A->B` form; every
    // other operator (`+>` future, `+<` past, `+<>` both, `+'label'>` named flow)
    // leaves it set. Those carry a temporal or flow semantic the canonical
    // Relation cannot express, and reducing them to a present-tense DependsOn
    // would invent a dependency (and duplicate an existing one), so drop them.
    if (link.flow === true || link.future === true || link.past === true || link.flowValue !== undefined) {
      warnings.push(`link "${link.start}" -> "${link.end}" dropped: flow/future/past variants have no canonical projection`);
      continue;
    }
    if (link.context !== undefined) {
      warnings.push(`link "${link.start}" -> "${link.end}": trailing context text dropped`);
    }
    const consumer = idByOwmName.get(link.start);
    const supplier = idByOwmName.get(link.end);
    if (consumer === undefined || supplier === undefined) {
      warnings.push(
        `link "${link.start}" -> "${link.end}" dropped: ${consumer === undefined ? link.start : link.end} is not a declared component`,
      );
      continue;
    }
    // OWM `A->B` reads "A consumes B": start = consumer, end = supplier.
    relations.push({ id: `rel-${relations.length + 1}`, consumer, supplier });
  }

  for (const { key, label } of UNPROJECTED_CONTAINERS) {
    const container = owm[key];
    if (Array.isArray(container) && container.length > 0) {
      warnings.push(`${container.length} ${label} ignored (no canonical projection)`);
    }
  }
  if (owm.presentation?.style) warnings.push('`style` directive ignored (presentation lives in renderConfig)');
  const size = owm.presentation?.size;
  if (size && (size.width > 0 || size.height > 0)) {
    warnings.push('`size` directive ignored (canvas size lives in renderConfig)');
  }
  if (owm.errors.length > 0) {
    warnings.push(`${owm.errors.length} source line(s) rejected by the OWM parser`);
  }
  for (const keyword of UNPARSED_KEYWORDS) {
    const hits = rawLines.filter((l) => l.trim().startsWith(`${keyword} `)).length;
    if (hits > 0) {
      warnings.push(`${hits} \`${keyword}\` line(s) ignored: unsupported by the vendored OWM parser`);
    }
  }

  // Parse to apply renderer defaults and guarantee a schema-valid canonical map.
  return WardleyMapSchema.parse({ title: owm.title, components, relations });
}

export class RenderWardleyMapOwmParseDslStrategy extends BaseStrategy<
  unknown,
  RenderWardleyMapOwmParseDslResult
> {
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<RenderWardleyMapOwmParseDslResult>> {
    const capturedAt = new Date().toISOString();
    const validated = InputSchema.safeParse(input);

    if (!validated.success) {
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: 'cannot parse: input does not carry a `dsl` string (upstream step not yet promoted?)',
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: { map: null, parsed: false, warnings: [] },
      };
    }

    const { dsl } = validated.data;
    const warnings: string[] = [];
    let map: WardleyMap;
    try {
      map = toCanonicalMap(parseOwm(dsl), dsl, warnings);
    } catch (err) {
      // Defensive: the vendored parser is not total on adversarial input, and a
      // clamped-but-still-odd map could be rejected by the canonical schema.
      return {
        signals: [{ name: 'input-valid', value: true, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: `cannot parse: ${err instanceof Error ? err.message : String(err)}`,
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: { map: null, parsed: false, warnings },
      };
    }

    return {
      signals: [
        { name: 'dslBytes', value: dsl.length, source: 'user-input', capturedAt },
        { name: 'componentCount', value: map.components.length, source: 'computed', capturedAt },
        { name: 'relationCount', value: map.relations.length, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: warnings.map((text) => ({ text, by: METHOD_ID, type: 'other' as const })),
      result: { map, parsed: true, warnings },
    };
  }
}
