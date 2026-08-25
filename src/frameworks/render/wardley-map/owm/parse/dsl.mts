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
// Same rule for the preamble directives (`style`, `size`, `evolution`): the
// vendored parser fills their containers with DEFAULTS on every parse, so the
// warning is raised from a scan of the SOURCE LINES (`hasDirective`) — never
// from the parsed value, which would make every source noisy.
//
// Graceful by design (degradation-first): any OWM construction that has no home
// in the canonical schema is IGNORED and reported in `warnings`; the strategy
// never throws on a syntactically odd source. A non-string input degrades to
// `{ map: null, parsed: false }` plus an insight, like the emit/svg strategy.

import { z } from 'zod';
import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { readRenderConfig, withoutRenderConfig } from '#schemas/render-config-passthrough.mjs';
import { PurposeContextSchema, type PurposeContext } from '#schemas/context.schema.mjs';
import { TemporalitySchema } from '#schemas/value-chain.schema.mjs';
import { parse as parseOwm, type UnifiedWardleyMap } from '#lib/vendor/cli-owm/index.mjs';
import { parseHeaderComments } from '#lib/owm/owm-dsl.mjs';
import { flipVisibility, uniqueSlug } from '#lib/owm/canonical-ids.mjs';

const METHOD_ID = 'render:wardley-map:owm:parse:dsl';

/** Local input contract — the DSL source, nothing else. */
const InputSchema = z.object({ dsl: z.string() });

export type RenderWardleyMapOwmParseDslInput = z.infer<typeof InputSchema>;

export interface RenderWardleyMapOwmParseDslResult {
  map: WardleyMap | null;
  parsed: boolean;
  warnings: string[];
  /** Raw `// key: value` header pairs, verbatim (source of truth). */
  header?: Record<string, string>;
  /** Best-effort projection of the header onto the study Context shape the
   *  iteration/purpose strategies consume. Only present when a header exists. */
  context?: PurposeContext;
}

/** French header-key aliases, folded onto the canonical English keys. The raw
 *  `header` keeps the spelling as written; only the projections use this. */
const HEADER_KEY_ALIASES: Record<string, string> = {
  contexte: 'context',
  objectif: 'objective',
  portee: 'scope',
  'portée': 'scope',
  perimetre: 'scope',
  'périmètre': 'scope',
  temporalite: 'temporality',
  'temporalité': 'temporality',
  granularite: 'granularity',
  'granularité': 'granularity',
  livrables: 'deliverables',
};

/** Canonical view of a raw header: alias keys folded, first value wins. */
function normalizeHeaderKeys(header: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(header)) {
    const canonical = HEADER_KEY_ALIASES[key] ?? key;
    if (!(canonical in normalized)) normalized[canonical] = value;
  }
  return normalized;
}

/** Header keys with a structured home. Everything else stays raw in `header`. */
function headerToPurposeContext(
  header: Record<string, string>,
  warnings: string[],
): PurposeContext {
  const temporality = header.temporality !== undefined
    ? TemporalitySchema.safeParse(header.temporality)
    : undefined;
  if (temporality !== undefined && !temporality.success) {
    warnings.push(
      `header temporality "${header.temporality}" is not past|present|future; defaulted to present`,
    );
  }
  return PurposeContextSchema.parse({
    ...(header.objective !== undefined ? { title: header.objective } : {}),
    ...(header.scope !== undefined ? { scope: header.scope } : {}),
    ...(header.angle !== undefined ? { angle: header.angle } : {}),
    ...(header.granularity !== undefined ? { granularity: header.granularity } : {}),
    ...(temporality?.success ? { temporality: temporality.data } : {}),
    ...(header.deliverables !== undefined
      ? { deliverables: header.deliverables.split(',').map((d) => d.trim()).filter(Boolean) }
      : {}),
  });
}

/** One element as the vendored parser returns it (anchors and components alike). */
type OwmElement = UnifiedWardleyMap['components'][number];

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

// Keywords the vendored Converter has NO extraction strategy for — the lines are
// silently discarded (they even raise a parse error in LinksExtractionStrategy).
// Worth a warning: the caller's source carries intent we cannot represent.
const UNPARSED_KEYWORDS = ['market', 'ecosystem', 'buy', 'build', 'outsource'] as const;

/** Containers the parser fills but the canonical schema has no home for.
 *  (pipelines/evolved/evolution graduated to real projections — see below.) */
const UNPROJECTED_CONTAINERS: ReadonlyArray<{ key: keyof UnifiedWardleyMap; label: string }> = [
  { key: 'submaps', label: '`submap` declaration(s)' },
  { key: 'notes', label: '`note` declaration(s)' },
  { key: 'annotations', label: '`annotation` declaration(s)' },
  { key: 'urls', label: '`url` declaration(s)' },
  { key: 'attitudes', label: 'attitude zone(s) (pioneers/settlers/townplanners)' },
  { key: 'accelerators', label: '`accelerator`/`deaccelerator` marker(s)' },
];

// The renderer's generic method decorator, instantiated for OWM's inline
// `(build|buy|outsource)` markers. Category value follows the schema's own
// example ("buying-policy"); per-category styling lives in the renderConfig.
const METHOD_CATEGORY = 'buying-policy';
const METHOD_DECORATORS = ['build', 'buy', 'outsource'] as const;

/**
 * Does the SOURCE actually carry a `<keyword> …` preamble directive?
 *
 * The vendored parser fills `presentation.style` and the four evolution axis
 * labels with DEFAULTS on every parse, so a guard on the PARSED value fires for
 * every source — including irreproachable ones — and drowns the real warnings in
 * ambient noise. Only the source line is evidence that the author wrote the
 * directive, exactly like the `label [` scan in `toCanonicalMap`.
 */
function hasDirective(rawLines: readonly string[], keyword: string): boolean {
  const pattern = new RegExp(`^${keyword}\\s`);
  return rawLines.some((l) => pattern.test(l.trim()));
}

/** The four default OWM axis labels — a parse always returns them, so only a
 *  source that really carries an `evolution` directive yields custom phases. */
function customPhases(owm: UnifiedWardleyMap, rawLines: readonly string[]): string[] | undefined {
  if (!hasDirective(rawLines, 'evolution')) return undefined;
  // Trim: the vendored extraction keeps spaces around `->` separators, and
  // phases are display labels (our emitter writes the separator unspaced).
  // Guard: a directive with fewer than 4 labels leaves undefined slots in the
  // vendored array — drop them instead of crashing the whole parse.
  const labels = owm.evolution
    .filter((l): l is typeof l & { line1: string } => typeof l?.line1 === 'string')
    .map((l) => (l.line2 ? `${l.line1} ${l.line2}` : l.line1).trim())
    .filter((s) => s.length > 0);
  return labels.length > 0 ? labels : undefined;
}

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

  // `evolve <name> <maturity>` directives and `pipeline <name> [m1, m2]`
  // declarations live in their own buckets, keyed by the raw declaration
  // spelling. First occurrence wins, duplicates are reported.
  const evolveByName = new Map<string, number>();
  // any: vendored MapEvolved is Record<string, unknown>; fields probed above.
  for (const ev of owm.evolved as Array<{ name: string; maturity: number }>) {
    if (evolveByName.has(ev.name)) {
      warnings.push(`duplicate \`evolve\` for "${ev.name}"; the first target wins`);
    } else {
      evolveByName.set(ev.name, ev.maturity);
    }
  }
  const pipelineByName = new Map<string, { m1: number; m2: number }>();
  // any: vendored MapPipelines is Record<string, unknown>; fields probed above.
  for (const p of owm.pipelines as Array<{ name: string; maturity1: number; maturity2: number }>) {
    if (pipelineByName.has(p.name)) {
      warnings.push(`duplicate \`pipeline\` for "${p.name}"; the first declaration wins`);
    } else {
      pipelineByName.set(p.name, { m1: p.maturity1, m2: p.maturity2 });
    }
  }

  const usedIds = new Set<string>();
  const idByOwmName = new Map<string, string>();
  const components = elements.map((el) => {
    const name = decodeComponentName(el.name ?? '');
    const id = uniqueSlug(name, usedIds);

    // Links reference components by their RAW (formatted) declaration spelling.
    if (idByOwmName.has(el.name)) {
      warnings.push(`duplicate component name "${el.name}"; links resolve to the first declaration`);
    } else {
      idByOwmName.set(el.name, id);
    }

    const hasExplicitLabel =
      lineNumbersTrustworthy &&
      typeof el.line === 'number' &&
      (rawLines[el.line - 1] ?? '').includes('label [');

    const visScalar = flipVisibility(clamp01(el.visibility));

    // OWM decorators: `(build|buy|outsource)` → the renderer's generic method
    // decorator. `(market|ecosystem)` have no canonical home yet.
    const activeMethods = METHOD_DECORATORS.filter((d) => el.decorators?.[d] === true);
    if (activeMethods.length > 1) {
      warnings.push(`component "${name}": multiple method decorators; keeping (${activeMethods[0]})`);
    }
    if (el.decorators?.market === true || el.decorators?.ecosystem === true) {
      warnings.push(`component "${name}": (market)/(ecosystem) decorator ignored (no canonical projection)`);
    }

    const evolveTarget = evolveByName.get(el.name);
    const pipeline = pipelineByName.get(el.name);
    if (pipeline !== undefined && el.type === 'anchor') {
      warnings.push(`\`pipeline\` on anchor "${name}" ignored`);
    }

    const hasPipeline = pipeline !== undefined && el.type !== 'anchor';
    return {
      id,
      label: {
        name,
        ...(hasExplicitLabel && el.label
          ? { position: { dx: el.label.x, dy: el.label.y } }
          : {}),
      },
      // OWM `submap` never reaches here (own bucket); anchors keep their type,
      // a `pipeline`-decorated component becomes the canonical `pipeline` type
      // (the renderer refuses pipelineGeometry on any other type), everything
      // else lands on the generic canonical `component`.
      type:
        el.type === 'anchor'
          ? ('anchor' as const)
          : hasPipeline
            ? ('pipeline' as const)
            : ('component' as const),
      position: {
        evolution: { scalar: clamp01(el.maturity) },
        visibility: { scalar: visScalar },
      },
      ...(el.inertia === true ? { inertia: true } : {}),
      ...(activeMethods.length > 0
        ? { method: { category: METHOD_CATEGORY, recommendation: activeMethods[0] } }
        : {}),
      // `evolve` moves along X only: the target keeps the component's
      // visibility. The renderer draws the inertia wall from the TARGET's
      // inertia flag, so the component-level marker is mirrored there.
      ...(evolveTarget !== undefined
        ? {
            evolvesTo: [
              {
                position: {
                  evolution: { scalar: clamp01(evolveTarget) },
                  visibility: { scalar: visScalar },
                },
                ...(el.inertia === true ? { inertia: true } : {}),
              },
            ],
          }
        : {}),
      // OWM pipeline is a horizontal maturity band at the component's row.
      ...(hasPipeline
        ? {
            pipelineGeometry: {
              evoStart: clamp01(Math.min(pipeline.m1, pipeline.m2)),
              evoEnd: clamp01(Math.max(pipeline.m1, pipeline.m2)),
              visStart: visScalar,
              visEnd: visScalar,
            },
          }
        : {}),
    };
  });

  // `evolve`/`pipeline` lines naming an undeclared component carry intent we drop.
  for (const name of evolveByName.keys()) {
    if (!idByOwmName.has(name)) warnings.push(`\`evolve ${name}\` dropped: not a declared component`);
  }
  for (const name of pipelineByName.keys()) {
    if (!idByOwmName.has(name)) warnings.push(`\`pipeline ${name}\` dropped: not a declared component`);
  }

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
  // Both are guarded on the SOURCE, not on the parsed `presentation`: the
  // vendored parser fills that container with defaults for every source (see
  // `hasDirective`), so guarding on the value warns about directives nobody
  // wrote.
  if (hasDirective(rawLines, 'style')) {
    warnings.push('`style` directive ignored (presentation lives in renderConfig)');
  }
  if (hasDirective(rawLines, 'size')) {
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
  // The `// context:` header value has a first-class home on the canonical map.
  const context = normalizeHeaderKeys(parseHeaderComments(dsl)).context;
  const map = WardleyMapSchema.parse({
    title: owm.title,
    components,
    relations,
    ...(context !== undefined ? { context } : {}),
  });

  // A custom `evolution A->B->…` directive re-labels the X-axis phases. The
  // renderConfig is a Zod pipe whose parsed shape is not re-parsable, so it
  // rides in INPUT shape next to the validated map (render-config-passthrough
  // idiom, same as the layout strategies). V3 input shape for phase labels:
  // style.background.phases.default.labels[].text.
  const phases = customPhases(owm, rawLines);
  return phases !== undefined
    ? ({
        ...map,
        renderConfig: {
          style: {
            background: {
              phases: { default: { labels: phases.map((text) => ({ text })) } },
            },
          },
        },
      } as WardleyMap)
    : map;
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
      // Recipe seam: an upstream lint on the `json` target hands over
      // `{ map, dsl: null, … }` — the map is already canonical, there is
      // nothing left to parse. Pass it through as-is (identity), so the
      // recipe output is uniform across both lint targets.
      const upstreamMap =
        input && typeof input === 'object' && 'map' in input
          ? // any: narrowed by the schema right below
            (input as { map: unknown }).map
          : undefined;
      if (upstreamMap !== null && upstreamMap !== undefined) {
        const passthrough = WardleyMapSchema.safeParse(withoutRenderConfig(upstreamMap));
        if (passthrough.success) {
          const rc = readRenderConfig(upstreamMap);
          const map = (rc !== undefined
            ? { ...passthrough.data, renderConfig: rc }
            : passthrough.data) as WardleyMap;
          return {
            signals: [
              { name: 'input-valid', value: true, source: 'computed', capturedAt },
              { name: 'passthrough', value: true, source: 'computed', capturedAt },
            ],
            reasoning: [],
            insights: [],
            result: { map, parsed: true, warnings: [] },
          };
        }
      }
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: 'cannot parse: input carries neither a `dsl` string nor a canonical `map` (upstream step not yet promoted?)',
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

    // Deterministic study-context capture: `// key: value` header comments.
    const header = parseHeaderComments(dsl);
    const hasHeader = Object.keys(header).length > 0;
    const context = hasHeader
      ? headerToPurposeContext(normalizeHeaderKeys(header), warnings)
      : undefined;

    return {
      signals: [
        { name: 'dslBytes', value: dsl.length, source: 'user-input', capturedAt },
        { name: 'componentCount', value: map.components.length, source: 'computed', capturedAt },
        { name: 'relationCount', value: map.relations.length, source: 'computed', capturedAt },
        { name: 'headerKeyCount', value: Object.keys(header).length, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: warnings.map((text) => ({ text, by: METHOD_ID, type: 'other' as const })),
      result: {
        map,
        parsed: true,
        warnings,
        ...(hasHeader ? { header, context } : {}),
      },
    };
  }
}
