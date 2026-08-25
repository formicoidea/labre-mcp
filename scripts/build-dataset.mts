// Synthetic Wardley-map dataset harness — WP3 (v1) + WP5 (v2, lossy dialect).
//
// Builds a corpus of canonical WardleyMaps and validates each one against TWO
// round-trip oracles. There is no LLM anywhere in this pipeline: generation is a
// seeded PRNG, both oracles are the real render strategies, so a full run is
// deterministic and reproducible from `--seed` alone.
//
//   Oracle A — OWM DSL idempotence (BYTE-EXACT)
//     canonical --emit:dsl--> dsl1 --parse:dsl--> map' --emit:dsl--> dsl2
//     dsl1 === dsl2, character for character.
//
//   Oracle B — SVG structural round-trip (EXACT + ε on scalars)
//     canonical --emit:svg--> svg --parse:svg--> map''
//     title / ids / labels / types / relations must match exactly; evolution and
//     visibility scalars within ±0.02 (the tolerance the parse strategy promises;
//     the error actually observed is float noise, ~1e-16).
//
// ── v2: the LOSSY dialect ──────────────────────────────────────────────
//
// v1 stayed inside the round-trippable dialect so that any failure was a
// regression signal. v2 deliberately steps OUTSIDE it: half the maps carry
// constructions the round-trips are DOCUMENTED to lose (subtype, nature,
// label offsets, non-default relation types; evolvesTo is svg-lossy only —
// OWM round-trips it as an `evolve` line). For those, silence is
// no longer the expectation — the harness asserts WHICH warning/insight each
// construction must produce:
//
//   (a) everything that is NOT lossy still round-trips exactly (oracles A + B);
//   (b) every declared `expectedLoss` is actually observed;
//   (c) no message is emitted that no `expectedLoss` accounts for.
//
// So the oracle bites in three directions: an undeclared loss (regression), a
// phantom warning (noise), and a loss that silently stopped happening.
//
// ── The loss contract, as OBSERVED from the strategies ─────────────────
//
// Losses are reported at two different moments, and the harness distinguishes
// them: an EMIT strategy declares up front what it is about to lose (`emit:dsl`
// and `emit:svg` insights), a PARSE strategy warns about what it could not
// project back (`parse:svg` warnings).
//
//   construct        │ owm (emit:dsl)              │ svg
//   ─────────────────┼─────────────────────────────┼──────────────────────────
//   subtype          │ insight "component taxonomy"│ market/ecosystem: parse:svg
//                    │                             │   warning (symbol seen)
//                    │                             │ others: emit:svg insight
//   nature           │ insight "component taxonomy"│ emit:svg insight
//   evolvesTo        │ NOT LOST (`evolve` line)    │ parse:svg warning: layer
//                    │                             │   dropped
//   label.position   │ on an ANCHOR: insight       │ emit:svg insight (always)
//                    │ on a component: NOT LOST    │
//   relation type    │ insight "relation type/flow"│ NOT LOST (stroke colour)
//
// The two "NOT LOST" cells are the reason no `expectedLoss` is recorded for
// them: their preservation is already asserted by the oracles themselves
// (byte-identity for the OWM label offset, `relation.type` equality for SVG).
// The four cells that used to read SILENT DROP (the WP5 finding: subtype
// without a symbol, nature, label offsets vanished through the SVG round-trip
// without a single message) are now DECLARED by `emit:svg` with the same
// accumulator contract as `emit:dsl` — a loss falling silent again is a
// regression this harness fails on.
//
// Run: npm run dataset -- [--count=N] [--seed=S] [--with-svg] [--lossless-only]
// Out: dataset/records.jsonl + dataset/summary.json (git-ignored).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { RenderWardleyMapOwmEmitDslStrategy } from '#frameworks/render/wardley-map/owm/emit/dsl.mjs';
import { RenderWardleyMapOwmParseDslStrategy } from '#frameworks/render/wardley-map/owm/parse/dsl.mjs';
import { RenderWardleyMapImageEmitSvgStrategy } from '#frameworks/render/wardley-map/image/emit/svg.mjs';
import { RenderWardleyMapImageParseSvgStrategy } from '#frameworks/render/wardley-map/image/parse/svg.mjs';
import { slugify } from '#lib/owm/canonical-ids.mjs';
import { EVOLVE_MATURITY_PATTERN, formatComponentName } from '#lib/owm/owm-dsl.mjs';

// ── Seeded PRNG ────────────────────────────────────────────────────────

/**
 * mulberry32 — 32-bit state, uniform [0,1), no dependency. Same seed ⇒ same
 * stream on every platform (all arithmetic is on Uint32 via `>>>`/`|0` and
 * Math.imul), which is what makes a whole dataset reproducible from `--seed`.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic per-map seed from the run seed and the map index (Knuth mix). */
export function mapSeed(runSeed: number, index: number): number {
  return (Math.imul(runSeed >>> 0, 0x9e3779b1) + Math.imul(index + 1, 0x85ebca6b)) >>> 0;
}

/**
 * Seed of the SIDE stream that drives the lossy dialect. Keeping the dialect
 * decisions off the map-generation stream is what makes `--lossless-only`
 * reproduce the v1 corpus byte for byte: adding v2 consumed not a single draw
 * of the base generator.
 */
export function dialectSeed(recordSeed: number): number {
  return (Math.imul(recordSeed >>> 0, 0x27d4eb2f) ^ 0x9e3779b9) >>> 0;
}

interface Rng {
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const rng: Rng = {
    float: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
  return rng;
}

/** Fisher-Yates on a copy, driven by the seeded Rng (stable for a given seed). */
function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

// ── Vocabulary ─────────────────────────────────────────────────────────
//
// Small embedded vocabulary — realistic multi-word Wardley labels without any
// character the OWM grammar reserves (`[ ] -> ; \n`) and without diacritics, so
// `slugify(label)` is stable across both parsers.

const ANCHOR_NAMES: readonly string[] = [
  'Retail Customer', 'Wholesale Buyer', 'Public User', 'Field Engineer',
  'Compliance Officer', 'Support Agent', 'Data Analyst', 'Product Owner',
  'Partner Merchant', 'Regulator',
];

const HEADS: readonly string[] = [
  'Order', 'Payment', 'Identity', 'Catalogue', 'Search', 'Billing', 'Pricing',
  'Fraud', 'Content', 'Telemetry', 'Inventory', 'Delivery', 'Customer Data',
  'Notification', 'Access',
];

const TAILS: readonly string[] = [
  'Service', 'Platform', 'Gateway', 'Store', 'Engine', 'Registry', 'Workflow',
  'Ledger', 'Cache', 'Index', 'Cluster', 'Broker',
];

const QUALIFIERS: readonly string[] = [
  'Managed', 'Self Service', 'Shared', 'Regional', 'Internal', 'Third Party',
  'Real Time',
];

const UTILITIES: readonly string[] = [
  'Compute', 'Object Storage', 'Network Fabric', 'Message Bus', 'Power',
  'Relational Database', 'Certificate Authority',
];

const TITLE_SUBJECTS: readonly string[] = [
  'an online payment provider', 'a logistics marketplace', 'a public health portal',
  'a media streaming service', 'a field maintenance business', 'a retail bank',
  'an industrial IoT fleet', 'a ticketing platform',
];

const TITLE_LEADS: readonly string[] = [
  'Value chain of', 'Current landscape of', 'Strategic map of', 'Operating model of',
];

/** Deterministic tie-breaker suffixes, used when a drawn label is already taken. */
const DISAMBIGUATORS: readonly string[] = [
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
  'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron',
];

// ── Generation ─────────────────────────────────────────────────────────

// Id derivation — the shared canonical algorithm. A plain `component` leaks no
// id in the SVG, so the parse strategy re-derives it from the label: generating
// ids any other way would fail oracle B for a reason that has nothing to do
// with the strategies. Re-exported for the test's oracle assertions.
export { slugify };

/** Round like the canonical schema does at its boundary (`round3`). */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function drawLabel(rng: Rng, isAnchor: boolean): string {
  if (isAnchor) return rng.pick(ANCHOR_NAMES);
  const roll = rng.float(0, 1);
  // 1–2 words: a utility sitting on the commodity end of the chain.
  if (roll < 0.15) return rng.pick(UTILITIES);
  // 5+ words: exercises the OWM quote + `\n` wrapping (formatComponentName).
  if (roll < 0.3) {
    return `${rng.pick(QUALIFIERS)} ${rng.pick(HEADS)} ${rng.pick(TAILS)} For ${rng.pick(ANCHOR_NAMES)}`;
  }
  // 3–5 words.
  if (roll < 0.6) return `${rng.pick(QUALIFIERS)} ${rng.pick(HEADS)} ${rng.pick(TAILS)}`;
  // 2–3 words: the common case.
  return `${rng.pick(HEADS)} ${rng.pick(TAILS)}`;
}

/**
 * Draw a label whose slug is not already used. Labels must be unique because
 * BOTH parse strategies re-derive component ids from the label: a collision
 * would silently produce `<slug>-2` on one side only.
 */
function drawUniqueLabel(rng: Rng, isAnchor: boolean, usedSlugs: Set<string>, index: number): string {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const label = drawLabel(rng, isAnchor);
    if (!usedSlugs.has(slugify(label))) return label;
  }
  // Deterministic fallback — the disambiguator set is larger than the max map.
  const label = `${drawLabel(rng, isAnchor)} ${DISAMBIGUATORS[index % DISAMBIGUATORS.length]}`;
  return usedSlugs.has(slugify(label)) ? `${label} ${index}` : label;
}

/**
 * Generate one canonical map from a seed, strictly inside the OWM-round-trippable
 * dialect: `title`, `anchor`, `component`, plain `A->B` links. NO subtype /
 * nature / evolvesTo / pipeline / label offsets / relation flow.
 *
 * This is the v1 generator, UNTOUCHED — the lossy dialect is layered on top by
 * `generateMap` from a separate PRNG stream, so this function's draw sequence
 * (and therefore the whole v1 corpus) is byte-stable across the v2 change.
 */
export function generateBaseMap(seed: number): WardleyMap {
  const rng = makeRng(seed);

  const nodeCount = rng.int(2, 15);
  const anchorCount = Math.min(rng.int(0, 2), nodeCount - 1);

  // Visibility band per node, ascending (canonical: 0 = top of the value chain,
  // i.e. the MOST visible). Anchors come first, so they sit at the top like a
  // real value chain. The jitter never exceeds ±30% of a band, which keeps the
  // ordering strict and every pair of nodes ≥ 0.4 band apart — far enough for
  // the SVG edge/endpoint matcher (0.5px) and for the node de-duplication.
  const band = 0.96 / nodeCount;
  const usedSlugs = new Set<string>();

  const components = Array.from({ length: nodeCount }, (_, i) => {
    const isAnchor = i < anchorCount;
    const label = drawUniqueLabel(rng, isAnchor, usedSlugs, i);
    usedSlugs.add(slugify(label));
    const visibility = round3(0.02 + band * (i + 0.5 + rng.float(-0.3, 0.3)));
    const evolution = round3(rng.float(0.02, 0.98));
    return {
      id: slugify(label),
      label: { name: label },
      type: isAnchor ? ('anchor' as const) : ('component' as const),
      position: { evolution: { scalar: evolution }, visibility: { scalar: visibility } },
    };
  });

  // Relations form a DAG by construction: an edge always runs from a lower index
  // (more visible consumer) to a higher one (its supplier). Parents are drawn
  // mostly from the layer just above, sometimes from much higher up — that is
  // what produces the crossings a real map has.
  const relations: Array<{ id: string; consumer: string; supplier: string }> = [];
  const seen = new Set<string>();
  for (let i = 1; i < nodeCount; i += 1) {
    const parentCount = rng.chance(0.35) && i >= 2 ? 2 : 1;
    for (let p = 0; p < parentCount; p += 1) {
      // 25% of the time reach far up the chain (crossing edge), else stay local.
      const consumer = rng.chance(0.25)
        ? rng.int(0, i - 1)
        : rng.int(Math.max(0, i - 3), i - 1);
      const key = `${consumer}>${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push({
        id: `rel-${relations.length + 1}`,
        consumer: components[consumer].id,
        supplier: components[i].id,
      });
    }
  }

  const title = `${rng.pick(TITLE_LEADS)} ${rng.pick(TITLE_SUBJECTS)}`;
  return WardleyMapSchema.parse({ title, components, relations });
}

// ── The lossy dialect (v2) ─────────────────────────────────────────────

/** Whether a map stays inside the round-trippable dialect or steps outside it. */
export type DialectMode = 'lossless' | 'lossy';

/** The canonical constructions v2 injects on purpose. */
export type LossConstruct =
  | 'subtype'
  | 'nature'
  | 'evolvesTo'
  | 'label.position'
  | 'relation.type';

/** Which round-trip the expectation applies to. */
export type LossFormat = 'owm' | 'svg' | 'both';

/**
 * What the strategy is expected to DO about the loss:
 *   - `insight`      — declared by an EMIT strategy (`emit:dsl` / `emit:svg`);
 *   - `warning`      — discovered by a PARSE strategy (`parse:*` warnings);
 *   - `silent-drop`  — the construction vanishes without a single message. No
 *                      generated map declares one anymore (emit:svg closed the
 *                      last four cells), but the machinery stays: it is the
 *                      regression detector for a loss falling silent again.
 */
export type LossExpectation = 'warning' | 'insight' | 'silent-drop';

export interface ExpectedLoss {
  construct: LossConstruct;
  /** Component id (or relation id for `relation.type`) the construct sits on. */
  target: string;
  /** The injected value, when it changes the expectation (`market`, `Flow`, …). */
  detail?: string;
  format: LossFormat;
  expectation: LossExpectation;
}

export interface ObservedLoss extends ExpectedLoss {
  /** `both` expands into one observation per side. */
  format: 'owm' | 'svg';
  observed: boolean;
  /** Message that satisfied the expectation, or why it was not satisfied. */
  evidence: string | null;
}

export interface GeneratedMap {
  mode: DialectMode;
  map: WardleyMap;
  expectedLoss: ExpectedLoss[];
}

/** Subtypes the injector draws from (the spec's list). */
const INJECTABLE_SUBTYPES = ['userNeed', 'market', 'ecosystem', 'solution', 'functional'] as const;

/**
 * Natures the canonical schema accepts on `component` + `functional`. Nature is
 * cross-validated against (type, subtype), which is why the injector never puts
 * a nature on a bare component: the schema would reject the map at generation.
 */
const FUNCTIONAL_NATURES = ['practice', 'data', 'activity', 'knowledge'] as const;

/** Subtypes the renderer draws with a symbol `parse:svg` recognises but cannot restore. */
const EXOTIC_SUBTYPES: ReadonlySet<string> = new Set(['market', 'ecosystem']);

const ALL_CONSTRUCTS: readonly LossConstruct[] = [
  'subtype',
  'nature',
  'evolvesTo',
  'label.position',
  'relation.type',
];

/**
 * `subtype` on a component: OWM declares it at emit. On the SVG side an exotic
 * subtype is drawn with a symbol `parse:svg` warns about; any other subtype has
 * no glyph at all, so `emit:svg` declares the drop itself.
 */
function subtypeLosses(target: string, subtype: string): ExpectedLoss[] {
  return [
    { construct: 'subtype', target, detail: subtype, format: 'owm', expectation: 'insight' },
    {
      construct: 'subtype',
      target,
      detail: subtype,
      format: 'svg',
      expectation: EXOTIC_SUBTYPES.has(subtype) ? 'warning' : 'insight',
    },
  ];
}

/**
 * Inject 1–4 lossy constructions into a copy of `base` and declare, for each
 * one, exactly what the two round-trips are expected to do with it. A construct
 * whose pool is exhausted (a 2-node map has a single non-anchor component) is
 * skipped rather than forced — the draw stays deterministic either way.
 */
function injectLossyConstructs(
  base: WardleyMap,
  rng: Rng,
): { map: WardleyMap; expectedLoss: ExpectedLoss[] } {
  const draft: WardleyMap = structuredClone(base);
  const expectedLoss: ExpectedLoss[] = [];

  const constructs = shuffled(ALL_CONSTRUCTS, rng).slice(0, rng.int(1, 4));

  for (const construct of constructs) {
    switch (construct) {
      case 'subtype': {
        const pool = draft.components.filter((c) => c.type !== 'anchor' && c.subtype === undefined);
        if (pool.length === 0) break;
        const target = rng.pick(pool);
        const subtype = rng.pick(INJECTABLE_SUBTYPES);
        target.subtype = subtype;
        expectedLoss.push(...subtypeLosses(target.id, subtype));
        break;
      }

      case 'nature': {
        // `nature` is only schema-legal under a subtype, so injecting it always
        // injects `functional` too — and therefore declares BOTH losses.
        const pool = draft.components.filter((c) => c.type !== 'anchor' && c.subtype === undefined);
        if (pool.length === 0) break;
        const target = rng.pick(pool);
        const nature = rng.pick(FUNCTIONAL_NATURES);
        target.subtype = 'functional';
        target.nature = nature;
        expectedLoss.push(...subtypeLosses(target.id, 'functional'));
        expectedLoss.push(
          { construct: 'nature', target: target.id, detail: nature, format: 'owm', expectation: 'insight' },
          { construct: 'nature', target: target.id, detail: nature, format: 'svg', expectation: 'insight' },
        );
        break;
      }

      case 'evolvesTo': {
        // Only OWM-referenceable targets: the `evolve <name> <maturity>` line
        // cannot reference a quote-wrapped name and misbinds on a name with an
        // embedded decimal (emit refuses both with an insight). Those hostile
        // shapes are pinned by the emit unit tests, not injected here.
        const pool = draft.components.filter(
          (c) =>
            c.type !== 'anchor' &&
            c.evolvesTo === undefined &&
            !formatComponentName(c.label.name).includes('"') &&
            !EVOLVE_MATURITY_PATTERN.test(` ${c.label.name}`),
        );
        if (pool.length === 0) break;
        const target = rng.pick(pool);
        const from = target.position.evolution.scalar;
        // Always a forward move, clamped inside the axis; never a no-op.
        const to = from >= 0.9 ? round3(from - rng.float(0.05, 0.3)) : round3(Math.min(0.98, from + rng.float(0.05, 0.3)));
        target.evolvesTo = [
          {
            position: {
              evolution: { scalar: to },
              visibility: { scalar: target.position.visibility.scalar },
            },
            evolveType: 'natural',
          },
        ];
        // OWM: NOT LOST since the deterministic evolve projection — the target
        // round-trips as an `evolve <name> <maturity>` line (round2 precision).
        expectedLoss.push(
          { construct: 'evolvesTo', target: target.id, format: 'svg', expectation: 'warning' },
        );
        break;
      }

      case 'label.position': {
        const pool = draft.components.filter((c) => c.label.position === undefined);
        if (pool.length === 0) break;
        // Anchors are the interesting half (the OWM anchor grammar has no
        // `label [dx, dy]`, so the offset is LOST there while it round-trips on
        // a plain component); force a coin flip towards them when the map has any.
        const anchors = pool.filter((c) => c.type === 'anchor');
        const target = anchors.length > 0 && rng.chance(0.5) ? rng.pick(anchors) : rng.pick(pool);
        // Integers: `fmtLabel` rounds, so only integers are byte-stable in OWM.
        const dx = rng.int(1, 40) * (rng.chance(0.5) ? 1 : -1);
        const dy = rng.int(1, 30) * (rng.chance(0.5) ? 1 : -1);
        target.label.position = { dx, dy };
        if (target.type === 'anchor') {
          expectedLoss.push({
            construct: 'label.position',
            target: target.id,
            detail: 'anchor',
            format: 'owm',
            expectation: 'insight',
          });
        }
        // On a plain component the OWM round-trip KEEPS the offset (`emit` writes
        // `label [dx, dy]`, `parse` lifts it back), so there is nothing to declare
        // for owm — byte-identity is the assertion that proves it.
        expectedLoss.push({
          construct: 'label.position',
          target: target.id,
          detail: target.type,
          format: 'svg',
          expectation: 'insight',
        });
        break;
      }

      case 'relation.type': {
        const pool = draft.relations.filter((r) => r.type === 'DependsOn');
        if (pool.length === 0) break;
        const target = rng.pick(pool);
        const type = rng.chance(0.5) ? ('Flow' as const) : ('Constraint' as const);
        target.type = type;
        // SVG keeps it: the renderer colours the edge and `parse:svg` maps the
        // stroke back to the type, so `compareSvgRoundTrip` asserts the survival.
        expectedLoss.push({
          construct: 'relation.type',
          target: target.id,
          detail: type,
          format: 'owm',
          expectation: 'insight',
        });
        break;
      }
    }
  }

  return { map: WardleyMapSchema.parse(draft), expectedLoss };
}

/**
 * Generate one dataset map. The dialect mode is drawn from a SIDE stream
 * (`dialectSeed`), so `generateMap(seed, 'lossless').map` is bit-for-bit the map
 * v1 produced for that seed.
 */
export function generateMap(seed: number, forceMode?: DialectMode): GeneratedMap {
  const base = generateBaseMap(seed);
  const dialect = makeRng(dialectSeed(seed));
  const mode: DialectMode = forceMode ?? (dialect.chance(0.5) ? 'lossy' : 'lossless');
  if (mode === 'lossless') return { mode: 'lossless', map: base, expectedLoss: [] };

  const { map, expectedLoss } = injectLossyConstructs(base, dialect);
  // Every pool can be empty on a minimal map; a lossy draw that injected nothing
  // is simply a lossless record, not a record with an empty contract to verify.
  if (expectedLoss.length === 0) return { mode: 'lossless', map: base, expectedLoss: [] };
  return { mode: 'lossy', map, expectedLoss };
}

// ── Oracles ────────────────────────────────────────────────────────────

const CTX: RequestContext = {
  projectId: 'dataset',
  projectRoot: process.cwd(),
  sessionId: 'build-dataset',
  domain: 'render',
};

const emitDsl = new RenderWardleyMapOwmEmitDslStrategy();
const parseDsl = new RenderWardleyMapOwmParseDslStrategy();
const emitSvg = new RenderWardleyMapImageEmitSvgStrategy();
const parseSvg = new RenderWardleyMapImageParseSvgStrategy();

/** Scalar tolerance promised by `render:wardley-map:image:parse:svg`. */
export const SCALAR_EPSILON = 0.02;

export interface OwmStats {
  /** emit(parse(emit(map))) === emit(map), character for character. */
  byteExact: boolean;
  /** Everything the OWM pipeline said, both sides merged (v1 field). */
  warnings: string[];
  /** Losses `emit:dsl` declared up front. */
  emitInsights: string[];
  /** Constructions `parse:dsl` could not project back. */
  parseWarnings: string[];
}

export interface SvgStats {
  /** Worst |Δ| over every evolution/visibility scalar of the map. */
  maxScalarError: number;
  /** Constructions `parse:svg` could not project back. */
  warnings: string[];
  /** Losses `emit:svg` declared up front (mirrors OwmStats.emitInsights). */
  emitInsights: string[];
}

export interface OracleReport {
  pass: boolean;
  failures: string[];
}

export interface OracleOutcome {
  dsl: string;
  svg: string;
  owmStats: OwmStats;
  svgStats: SvgStats;
  observedLoss: ObservedLoss[];
  oracle: OracleReport;
}

/** One message, tagged with the moment it was produced. */
interface LossMessage {
  text: string;
  origin: 'insight' | 'warning';
}

/**
 * The exact substrings a loss must produce, per format — the machine-readable
 * form of the contract table in this file's header. `null` means this pair
 * (construct, format) has no message contract at all: either the construct is
 * silently dropped, or it is not lost on that side.
 */
function lossFragments(loss: ExpectedLoss, format: 'owm' | 'svg'): string[] | null {
  if (format === 'owm') {
    switch (loss.construct) {
      case 'subtype':
      case 'nature':
        return ['component taxonomy (subtype/nature) has no OWM equivalent'];
      case 'evolvesTo':
        // NOT LOST on owm since the evolve projection — no owm expectation is
        // ever recorded for it, this branch is unreachable and kept explicit.
        return null;
      case 'label.position':
        // Only the ANCHOR offset is dropped; a component offset round-trips.
        return loss.detail === 'anchor'
          ? ['anchor label offsets have no OWM equivalent']
          : null;
      case 'relation.type':
        return ['relation type/flow annotations are not projected'];
    }
  }
  switch (loss.construct) {
    case 'subtype':
      return loss.detail !== undefined && EXOTIC_SUBTYPES.has(loss.detail)
        ? [`component "${loss.target}"`, `is drawn with the ${loss.detail} symbol`]
        : ['component taxonomy (subtype/nature) has no distinct SVG symbol'];
    case 'nature':
      return ['component taxonomy (subtype/nature) has no distinct SVG symbol'];
    case 'label.position':
      return ['label offsets (label.position) are not recoverable from an SVG render'];
    case 'evolvesTo':
      return ['layer "evolvesTo" is not parsed by this strategy'];
    default:
      return null;
  }
}

/** Did the construction survive the round-trip? A `silent-drop` must answer no. */
function lossSurvived(loss: ExpectedLoss, parsed: WardleyMap | null): boolean {
  if (parsed === null) return false;
  const component = parsed.components.find((c) => c.id === loss.target);
  switch (loss.construct) {
    case 'subtype':
      return component?.subtype !== undefined;
    case 'nature':
      return component?.nature !== undefined;
    case 'evolvesTo':
      return (component?.evolvesTo?.length ?? 0) > 0;
    case 'label.position':
      return component?.label.position !== undefined;
    case 'relation.type': {
      const relation = parsed.relations.find((r) => r.id === loss.target);
      return relation !== undefined && relation.type !== 'DependsOn';
    }
  }
}

function formatsOf(loss: ExpectedLoss): Array<'owm' | 'svg'> {
  return loss.format === 'both' ? ['owm', 'svg'] : [loss.format];
}

/** Compare the SVG round-trip on everything the strategy contract guarantees. */
function compareSvgRoundTrip(source: WardleyMap, parsed: WardleyMap, failures: string[]): number {
  if (parsed.title !== source.title) {
    failures.push(`svg: title "${parsed.title}" !== "${source.title}"`);
  }
  if (parsed.components.length !== source.components.length) {
    failures.push(
      `svg: component count ${parsed.components.length} !== ${source.components.length}`,
    );
    return Number.POSITIVE_INFINITY;
  }
  if (parsed.relations.length !== source.relations.length) {
    failures.push(`svg: relation count ${parsed.relations.length} !== ${source.relations.length}`);
  }

  let worst = 0;
  for (let i = 0; i < source.components.length; i += 1) {
    const a = source.components[i];
    const b = parsed.components[i];
    if (b.id !== a.id) failures.push(`svg: component #${i} id "${b.id}" !== "${a.id}"`);
    if (b.label.name !== a.label.name) {
      failures.push(`svg: component #${i} label "${b.label.name}" !== "${a.label.name}"`);
    }
    if (b.type !== a.type) failures.push(`svg: component #${i} type ${b.type} !== ${a.type}`);
    const de = Math.abs(b.position.evolution.scalar - a.position.evolution.scalar);
    const dv = Math.abs(b.position.visibility.scalar - a.position.visibility.scalar);
    worst = Math.max(worst, de, dv);
    if (de > SCALAR_EPSILON) failures.push(`svg: component #${i} evolution drift ${de}`);
    if (dv > SCALAR_EPSILON) failures.push(`svg: component #${i} visibility drift ${dv}`);
  }

  const pairs = Math.min(source.relations.length, parsed.relations.length);
  for (let i = 0; i < pairs; i += 1) {
    const a = source.relations[i];
    const b = parsed.relations[i];
    if (b.id !== a.id) failures.push(`svg: relation #${i} id "${b.id}" !== "${a.id}"`);
    if (b.consumer !== a.consumer) {
      failures.push(`svg: relation #${i} consumer "${b.consumer}" !== "${a.consumer}"`);
    }
    if (b.supplier !== a.supplier) {
      failures.push(`svg: relation #${i} supplier "${b.supplier}" !== "${a.supplier}"`);
    }
    if (b.type !== a.type) failures.push(`svg: relation #${i} type ${b.type} !== ${a.type}`);
  }
  return worst;
}

/**
 * Check the declared loss contract against what the strategies actually said and
 * actually kept, and report every message nothing accounted for.
 *
 * `expectedLoss` empty (a lossless map) collapses this to the v1 rule: any
 * non-ambient message is a failure.
 */
function checkLossContract(
  expectedLoss: readonly ExpectedLoss[],
  owmMessages: readonly LossMessage[],
  svgMessages: readonly LossMessage[],
  parsedOwm: WardleyMap | null,
  parsedSvg: WardleyMap | null,
  failures: string[],
): ObservedLoss[] {
  const observed: ObservedLoss[] = [];
  const claimed = new Set<string>();
  const key = (format: 'owm' | 'svg', index: number): string => `${format}#${index}`;

  for (const loss of expectedLoss) {
    for (const format of formatsOf(loss)) {
      const messages = format === 'owm' ? owmMessages : svgMessages;
      const parsed = format === 'owm' ? parsedOwm : parsedSvg;
      const where = `${loss.construct}${loss.detail === undefined ? '' : `(${loss.detail})`} on "${loss.target}"`;

      if (loss.expectation === 'silent-drop') {
        const survived = lossSurvived(loss, parsed);
        observed.push({
          ...loss,
          format,
          observed: !survived,
          evidence: survived ? null : `absent from the ${format} round-trip, no message emitted`,
        });
        if (survived) {
          failures.push(
            `loss: ${where} was expected to be silently dropped by ${format} but survived the round-trip`,
          );
        }
        continue;
      }

      const fragments = lossFragments(loss, format);
      let hitIndex = -1;
      if (fragments !== null) {
        hitIndex = messages.findIndex(
          (m) => m.origin === loss.expectation && fragments.every((f) => m.text.includes(f)),
        );
      }
      if (hitIndex >= 0) claimed.add(key(format, hitIndex));
      observed.push({
        ...loss,
        format,
        observed: hitIndex >= 0,
        evidence: hitIndex >= 0 ? messages[hitIndex].text : null,
      });
      if (hitIndex < 0) {
        failures.push(
          `loss: expected ${loss.expectation} from ${format} about ${where}, none was emitted`,
        );
      }
    }
  }

  // Rule (c): every message must be accounted for — a phantom warning is as much
  // a defect as a missing one (it is the noise that makes a harness unusable).
  owmMessages.forEach((m, i) => {
    if (claimed.has(key('owm', i))) return;
    failures.push(`owm: unexpected ${m.origin}: ${m.text}`);
  });
  svgMessages.forEach((m, i) => {
    if (claimed.has(key('svg', i))) return;
    failures.push(`svg: unexpected ${m.origin}: ${m.text}`);
  });

  return observed;
}

/**
 * Run both oracles on one canonical map. Never throws on map content.
 * `expectedLoss` declares the constructions this map is KNOWN to lose; leaving
 * it empty asserts a perfectly lossless round-trip (the v1 contract).
 */
export async function runOracles(
  map: WardleyMap,
  expectedLoss: readonly ExpectedLoss[] = [],
): Promise<OracleOutcome> {
  const failures: string[] = [];

  // ── Oracle A — OWM DSL idempotence ──────────────────────────────────
  const first = await emitDsl.evaluate(map, CTX);
  const emitInsights = first.insights.map((i) => i.text);
  const parseWarnings: string[] = [];
  let dsl = first.result.dsl;
  let byteExact = false;
  let parsedOwm: WardleyMap | null = null;

  if (!first.result.emitted) {
    failures.push('owm: emit:dsl refused the canonical map');
  } else {
    const back = await parseDsl.evaluate({ dsl }, CTX);
    parseWarnings.push(...back.result.warnings);
    if (!back.result.parsed || back.result.map === null) {
      failures.push('owm: parse:dsl could not read back the emitted DSL');
    } else {
      parsedOwm = back.result.map;
      const second = await emitDsl.evaluate(back.result.map, CTX);
      if (!second.result.emitted) {
        failures.push('owm: emit:dsl refused the re-parsed map');
      } else {
        byteExact = second.result.dsl === dsl;
        if (!byteExact) {
          failures.push(
            `owm: emit(parse(emit(m))) is not byte-exact (${dsl.length} vs ${second.result.dsl.length} bytes)`,
          );
          // Keep the DIVERGENT pair visible in the record: `dsl` stays the first
          // emission, the diff is spelled out in the failure below.
          const a = dsl.split('\n');
          const b = second.result.dsl.split('\n');
          for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
            if (a[i] !== b[i]) failures.push(`owm: line ${i + 1}: "${a[i] ?? ''}" !== "${b[i] ?? ''}"`);
          }
        }
      }
    }
  }

  // ── Oracle B — SVG structural round-trip ────────────────────────────
  const rendered = await emitSvg.evaluate(map, CTX);
  const svgEmitInsights = rendered.insights.map((i) => i.text);
  let svg = rendered.result.svg;
  let maxScalarError = Number.POSITIVE_INFINITY;
  const svgWarnings: string[] = [];
  let parsedSvg: WardleyMap | null = null;

  if (!rendered.result.rendered) {
    failures.push('svg: emit:svg refused the canonical map');
    svg = '';
  } else {
    const back = await parseSvg.evaluate({ svg }, CTX);
    svgWarnings.push(...back.result.warnings);
    if (!back.result.parsed || back.result.map === null) {
      failures.push('svg: parse:svg could not read back the rendered SVG');
    } else {
      parsedSvg = back.result.map;
      maxScalarError = compareSvgRoundTrip(map, parsedSvg, failures);
    }
  }

  // ── Loss contract: every declared loss observed, every message claimed ──
  const observedLoss = checkLossContract(
    expectedLoss,
    [
      ...emitInsights.map((text): LossMessage => ({ text, origin: 'insight' })),
      ...parseWarnings.map((text): LossMessage => ({ text, origin: 'warning' })),
    ],
    [
      ...svgEmitInsights.map((text): LossMessage => ({ text, origin: 'insight' })),
      ...svgWarnings.map((text): LossMessage => ({ text, origin: 'warning' })),
    ],
    parsedOwm,
    parsedSvg,
    failures,
  );

  return {
    dsl,
    svg,
    owmStats: {
      byteExact,
      warnings: [...emitInsights, ...parseWarnings],
      emitInsights,
      parseWarnings,
    },
    svgStats: { maxScalarError, warnings: svgWarnings, emitInsights: svgEmitInsights },
    observedLoss,
    oracle: { pass: failures.length === 0, failures },
  };
}

// ── Records ────────────────────────────────────────────────────────────

export interface DatasetRecord {
  id: string;
  seed: number;
  mode: DialectMode;
  map: WardleyMap;
  dsl: string;
  /** Full SVG document — only with `--with-svg` (it dwarfs everything else). */
  svg?: string;
  svgStats: SvgStats;
  owmStats: OwmStats;
  expectedLoss: ExpectedLoss[];
  observedLoss: ObservedLoss[];
  oracle: OracleReport;
}

export interface ModeStats {
  count: number;
  pass: number;
}

export interface DatasetSummary {
  count: number;
  seed: number;
  withSvg: boolean;
  losslessOnly: boolean;
  lossless: ModeStats;
  lossy: ModeStats;
  owmPassRate: number;
  svgPassRate: number;
  overallPassRate: number;
  maxScalarError: number;
  /** Total declared expectations (one per format, `both` counted twice). */
  expectedLosses: number;
  /** Losses that happened WITHOUT any message — the WP5 finding. */
  silentDrops: number;
  /** `construct/format` → how many silent drops were observed. */
  silentDropsByConstruct: Record<string, number>;
  failedRecords: string[];
  durationMs: number;
}

export interface DatasetBuild {
  records: DatasetRecord[];
  summary: DatasetSummary;
}

/** Generate `count` maps from `seed` and run both oracles on each. */
export async function buildDataset(
  count: number,
  seed: number,
  withSvg: boolean,
  losslessOnly = false,
): Promise<DatasetBuild> {
  const startedAt = performance.now();

  // Maps are fully independent — no shared state between oracle runs.
  const records = await Promise.all(
    Array.from({ length: count }, async (_, i): Promise<DatasetRecord> => {
      const recordSeed = mapSeed(seed, i);
      const generated = generateMap(recordSeed, losslessOnly ? 'lossless' : undefined);
      const outcome = await runOracles(generated.map, generated.expectedLoss);
      return {
        id: `map-${String(i + 1).padStart(5, '0')}`,
        seed: recordSeed,
        mode: generated.mode,
        map: generated.map,
        dsl: outcome.dsl,
        ...(withSvg ? { svg: outcome.svg } : {}),
        svgStats: outcome.svgStats,
        owmStats: outcome.owmStats,
        expectedLoss: generated.expectedLoss,
        observedLoss: outcome.observedLoss,
        oracle: outcome.oracle,
      };
    }),
  );

  const owmPass = records.filter((r) => r.owmStats.byteExact).length;
  const svgPass = records.filter(
    (r) => !r.oracle.failures.some((f) => f.startsWith('svg:')),
  ).length;
  const maxScalarError = records.reduce(
    (worst, r) => Math.max(worst, Number.isFinite(r.svgStats.maxScalarError) ? r.svgStats.maxScalarError : 1),
    0,
  );

  const modeStats = (mode: DialectMode): ModeStats => {
    const subset = records.filter((r) => r.mode === mode);
    return { count: subset.length, pass: subset.filter((r) => r.oracle.pass).length };
  };

  const silentDropsByConstruct: Record<string, number> = {};
  let silentDrops = 0;
  let expectedLosses = 0;
  for (const record of records) {
    for (const loss of record.observedLoss) {
      expectedLosses += 1;
      if (loss.expectation !== 'silent-drop' || !loss.observed) continue;
      silentDrops += 1;
      const bucket = `${loss.construct}/${loss.format}`;
      silentDropsByConstruct[bucket] = (silentDropsByConstruct[bucket] ?? 0) + 1;
    }
  }

  return {
    records,
    summary: {
      count,
      seed,
      withSvg,
      losslessOnly,
      lossless: modeStats('lossless'),
      lossy: modeStats('lossy'),
      owmPassRate: count === 0 ? 1 : owmPass / count,
      svgPassRate: count === 0 ? 1 : svgPass / count,
      overallPassRate: count === 0 ? 1 : records.filter((r) => r.oracle.pass).length / count,
      maxScalarError,
      expectedLosses,
      silentDrops,
      silentDropsByConstruct,
      failedRecords: records.filter((r) => !r.oracle.pass).map((r) => r.id),
      durationMs: Math.round(performance.now() - startedAt),
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────

export interface CliOptions {
  count: number;
  seed: number;
  withSvg: boolean;
  /** Force every map into the v1 dialect (same corpus, same strictness). */
  losslessOnly: boolean;
}

/**
 * Minimal hand-rolled argv parsing — no dependency. Both `--flag value` and
 * `--flag=value` are accepted: npm's own option parser eats a bare `--count`
 * before it reaches the script, so `--count=50` is the form that always works
 * through `npm run dataset -- …`.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { count: 200, seed: 42, withSvg: false, losslessOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--with-svg') {
      options.withSvg = true;
      continue;
    }
    if (arg === '--lossless-only') {
      options.losslessOnly = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (name === '--count' || name === '--seed') {
      const raw = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      const value = Number.parseInt(raw ?? '', 10);
      if (!Number.isInteger(value) || value < 0 || String(value) !== (raw ?? '').trim()) {
        throw new Error(`${name} expects a non-negative integer (got ${raw ?? '<nothing>'})`);
      }
      if (name === '--count') options.count = value;
      else options.seed = value;
      continue;
    }
    throw new Error(
      `unknown argument "${arg}" (usage: --count N --seed S --with-svg --lossless-only)`,
    );
  }
  return options;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function ratio(stats: ModeStats): string {
  return stats.count === 0 ? 'n/a' : `${stats.pass}/${stats.count} (${pct(stats.pass / stats.count)})`;
}

// Entry point — guarded so the test file can import the pieces above without
// writing anything to disk.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  const outDir = path.join(process.cwd(), 'dataset');
  const { records, summary } = await buildDataset(
    options.count,
    options.seed,
    options.withSvg,
    options.losslessOnly,
  );

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'records.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''),
    'utf8',
  );
  await writeFile(
    path.join(outDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );

  const flags = [summary.withSvg ? 'SVG embedded' : '', summary.losslessOnly ? 'lossless-only' : '']
    .filter((f) => f.length > 0)
    .join(', ');
  const lines = [
    `[build-dataset] ${summary.count} maps, seed ${summary.seed}${flags.length > 0 ? `, ${flags}` : ''}`,
    `  owm  emit→parse→emit byte-exact : ${pct(summary.owmPassRate)}`,
    `  svg  emit→parse structural      : ${pct(summary.svgPassRate)}`,
    `  max |Δ scalar|                  : ${summary.maxScalarError.toExponential(3)} (ε = ${SCALAR_EPSILON})`,
    `  lossless maps pass              : ${ratio(summary.lossless)}`,
    `  lossy    maps pass              : ${ratio(summary.lossy)}`,
    `  declared losses verified        : ${summary.expectedLosses}`,
    `  of which SILENT (no message)    : ${summary.silentDrops}`,
  ];
  for (const [bucket, n] of Object.entries(summary.silentDropsByConstruct).sort()) {
    lines.push(`      ${bucket.padEnd(26)}: ${n}`);
  }
  lines.push(
    `  overall pass                    : ${pct(summary.overallPassRate)}`,
    `  duration                        : ${summary.durationMs} ms`,
    `  written                         : dataset/records.jsonl, dataset/summary.json`,
  );
  if (summary.failedRecords.length > 0) {
    lines.push(`  FAILED (${summary.failedRecords.length}): ${summary.failedRecords.slice(0, 10).join(', ')}`);
    for (const record of records.filter((r) => !r.oracle.pass).slice(0, 3)) {
      for (const failure of record.oracle.failures.slice(0, 5)) {
        lines.push(`    ${record.id} [${record.mode}]: ${failure}`);
      }
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  if (summary.failedRecords.length > 0) process.exitCode = 1;
}
