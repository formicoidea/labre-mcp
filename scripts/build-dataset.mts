// Synthetic Wardley-map dataset harness — WP3 of "endpoints parse → JSON canonique".
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
// This is a QUALITY HARNESS, not just a generator: any oracle violation marks the
// record `oracle.pass=false` and the process exits 1.
//
// Run: npm run dataset -- [--count N] [--seed S] [--with-svg]
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
 * Generate one canonical map from a seed.
 *
 * Deliberately restricted to the OWM-round-trippable dialect: `title`, `anchor`,
 * `component`, plain `A->B` links. NO subtype / nature / evolvesTo / pipeline /
 * label offsets / relation flow — all of those are documented LOSSY projections
 * (see the headers of the four render strategies), and a v1 dataset is meant to
 * be clean: every record should pass both oracles, so a failure is always a
 * regression signal and never expected noise. Widening the dialect is a v2 job,
 * with per-record `expectedLoss` annotations.
 */
export function generateMap(seed: number): WardleyMap {
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
  warnings: string[];
}

export interface SvgStats {
  /** Worst |Δ| over every evolution/visibility scalar of the map. */
  maxScalarError: number;
  warnings: string[];
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
  oracle: OracleReport;
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

/** Run both oracles on one canonical map. Never throws on map content. */
export async function runOracles(map: WardleyMap): Promise<OracleOutcome> {
  const failures: string[] = [];

  // ── Oracle A — OWM DSL idempotence ──────────────────────────────────
  const first = await emitDsl.evaluate(map, CTX);
  const owmWarnings = first.insights.map((i) => i.text);
  let dsl = first.result.dsl;
  let byteExact = false;

  if (!first.result.emitted) {
    failures.push('owm: emit:dsl refused the canonical map');
  } else {
    const back = await parseDsl.evaluate({ dsl }, CTX);
    owmWarnings.push(...back.result.warnings);
    if (!back.result.parsed || back.result.map === null) {
      failures.push('owm: parse:dsl could not read back the emitted DSL');
    } else {
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
  let svg = rendered.result.svg;
  let maxScalarError = Number.POSITIVE_INFINITY;
  const svgWarnings: string[] = [];

  if (!rendered.result.rendered) {
    failures.push('svg: emit:svg refused the canonical map');
    svg = '';
  } else {
    const back = await parseSvg.evaluate({ svg }, CTX);
    svgWarnings.push(...back.result.warnings);
    if (!back.result.parsed || back.result.map === null) {
      failures.push('svg: parse:svg could not read back the rendered SVG');
    } else {
      maxScalarError = compareSvgRoundTrip(map, back.result.map, failures);
      // A renderer-emitted SVG of a clean map must drop nothing at all.
      for (const w of svgWarnings) failures.push(`svg: unexpected warning: ${w}`);
    }
  }

  return {
    dsl,
    svg,
    owmStats: { byteExact, warnings: owmWarnings },
    svgStats: { maxScalarError, warnings: svgWarnings },
    oracle: { pass: failures.length === 0, failures },
  };
}

// ── Records ────────────────────────────────────────────────────────────

export interface DatasetRecord {
  id: string;
  seed: number;
  map: WardleyMap;
  dsl: string;
  /** Full SVG document — only with `--with-svg` (it dwarfs everything else). */
  svg?: string;
  svgStats: SvgStats;
  owmStats: OwmStats;
  oracle: OracleReport;
}

export interface DatasetSummary {
  count: number;
  seed: number;
  withSvg: boolean;
  owmPassRate: number;
  svgPassRate: number;
  overallPassRate: number;
  maxScalarError: number;
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
): Promise<DatasetBuild> {
  const startedAt = performance.now();

  // Maps are fully independent — no shared state between oracle runs.
  const records = await Promise.all(
    Array.from({ length: count }, async (_, i): Promise<DatasetRecord> => {
      const recordSeed = mapSeed(seed, i);
      const map = generateMap(recordSeed);
      const outcome = await runOracles(map);
      return {
        id: `map-${String(i + 1).padStart(5, '0')}`,
        seed: recordSeed,
        map,
        dsl: outcome.dsl,
        ...(withSvg ? { svg: outcome.svg } : {}),
        svgStats: outcome.svgStats,
        owmStats: outcome.owmStats,
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

  return {
    records,
    summary: {
      count,
      seed,
      withSvg,
      owmPassRate: count === 0 ? 1 : owmPass / count,
      svgPassRate: count === 0 ? 1 : svgPass / count,
      overallPassRate: count === 0 ? 1 : records.filter((r) => r.oracle.pass).length / count,
      maxScalarError,
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
}

/**
 * Minimal hand-rolled argv parsing — no dependency. Both `--flag value` and
 * `--flag=value` are accepted: npm's own option parser eats a bare `--count`
 * before it reaches the script, so `--count=50` is the form that always works
 * through `npm run dataset -- …`.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { count: 200, seed: 42, withSvg: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--with-svg') {
      options.withSvg = true;
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
    throw new Error(`unknown argument "${arg}" (usage: --count N --seed S --with-svg)`);
  }
  return options;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// Entry point — guarded so the test file can import the pieces above without
// writing anything to disk.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  const outDir = path.join(process.cwd(), 'dataset');
  const { records, summary } = await buildDataset(options.count, options.seed, options.withSvg);

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

  const lines = [
    `[build-dataset] ${summary.count} maps, seed ${summary.seed}${summary.withSvg ? ', SVG embedded' : ''}`,
    `  owm  emit→parse→emit byte-exact : ${pct(summary.owmPassRate)}`,
    `  svg  emit→parse structural      : ${pct(summary.svgPassRate)}`,
    `  max |Δ scalar|                  : ${summary.maxScalarError.toExponential(3)} (ε = ${SCALAR_EPSILON})`,
    `  overall pass                    : ${pct(summary.overallPassRate)}`,
    `  duration                        : ${summary.durationMs} ms`,
    `  written                         : dataset/records.jsonl, dataset/summary.json`,
  ];
  if (summary.failedRecords.length > 0) {
    lines.push(`  FAILED (${summary.failedRecords.length}): ${summary.failedRecords.slice(0, 10).join(', ')}`);
    for (const record of records.filter((r) => !r.oracle.pass).slice(0, 3)) {
      for (const failure of record.oracle.failures.slice(0, 5)) {
        lines.push(`    ${record.id}: ${failure}`);
      }
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  if (summary.failedRecords.length > 0) process.exitCode = 1;
}
