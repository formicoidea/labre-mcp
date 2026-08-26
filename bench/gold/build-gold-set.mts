#!/usr/bin/env tsx
// Builds `bench/gold/gold-set.json` — the reference set the placement bench
// measures against.
//
// WHY NOT `dataset/records.jsonl`. The synthetic dataset (scripts/build-dataset.mts)
// carries no placement truth at all: its maps are drawn from a seeded PRNG, so
// every evolution scalar is a uniform random draw with no semantic meaning. It
// is a round-trip oracle for the render strategies, not a placement reference.
// Measuring placement against it would score noise.
//
// WHAT THE REFERENCE ACTUALLY IS. The three human-authored maps in `maps/myMaps/`
// carry evolution coordinates a person chose deliberately. That is the truth
// this bench uses, and its status must stay explicit: it is ONE annotator's
// placement, not an objective measurement. A posture that disagrees with it may
// be wrong, or may be right against a debatable authored position. That is why
// the harness reports per-map breakdowns — `tea-shop-hot-beverages` is the
// canonical Wardley teaching example (highest confidence), the other two are
// working maps of this repo's author.
//
// The output file is COMMITTED: the bench must be replayable without re-deriving
// the set, and a change to the reference must show up as a reviewable diff.
//
// Run: pnpm bench:gold

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RenderWardleyMapOwmParseDslStrategy } from '#frameworks/render/wardley-map/owm/parse/dsl.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import {
  stageOf,
  type EvolutionStage,
  type GoldCase,
  type GoldMap,
  type GoldSet,
} from '../bench.types.mjs';

const benchDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(benchDir, '..');

/** |predicted - truth| at or below this counts as correct. See README § Métriques. */
export const TOLERANCE = 0.1;

/** How many cases the reference set holds. The pilot runs a prefix of it. */
export const GOLD_SIZE = 15;

/**
 * Source maps, in a FIXED order (the selection below is deterministic and the
 * order is part of it). `context` is authored here, in English, and is handed
 * verbatim and identically to every posture — the engine's `ComponentInput`
 * has a `context` field, so this is the one channel all three arms share.
 */
const SOURCES: ReadonlyArray<{ key: string; file: string; context: string }> = [
  {
    key: 'tea-shop',
    file: 'maps/myMaps/tea-shop-hot-beverages.wm',
    context:
      'An independent tea shop serving hot beverages to walk-in customers, ' +
      'from the counter to the supply of tea and utilities.',
  },
  {
    key: 'spotify',
    file: 'maps/myMaps/spotify-streaming.wm',
    context:
      'Spotify, the global music streaming platform: a freemium intermediary ' +
      'between rights holders (labels, artists) and listeners, from content ' +
      'ingestion to the end-user experience.',
  },
  {
    key: 's2e',
    file: 'maps/myMaps/s2e-epargne-salariale.wm',
    context:
      'A French employee-savings service (epargne salariale) operated inside a ' +
      'banking group: account keeping, fund management and regulatory ' +
      'compliance for employees and their employers.',
  },
];

/** The reference date the placement question is asked about. */
const REFERENCE_DATE = '2026';

/** Stage cycle of the stratified selection — commodity first, genesis last,
 *  because the genesis bucket is the thinnest on real maps. */
const STAGE_CYCLE: readonly EvolutionStage[] = ['commodity', 'product', 'custom', 'genesis'];

const CTX: RequestContext = {
  projectId: 'bench-gold',
  projectRoot: repoRoot,
  sessionId: 'build-gold-set',
  domain: 'render',
};

interface Candidate {
  mapKey: string;
  mapIndex: number;
  /** Rank of this component inside its own map's bucket for its stage. */
  rankInBucket: number;
  goldCase: GoldCase;
}

/** Parse one `.wm` file into the evolution-free map view plus its candidates. */
async function readSource(
  source: (typeof SOURCES)[number],
  mapIndex: number,
): Promise<{ map: GoldMap; candidates: Candidate[] }> {
  const dsl = readFileSync(path.join(repoRoot, source.file), 'utf8');
  const parsed = await new RenderWardleyMapOwmParseDslStrategy().evaluate({ dsl }, CTX);
  const wardleyMap = parsed.result.map;
  if (!parsed.result.parsed || wardleyMap === null) {
    throw new Error(`could not parse ${source.file}`);
  }

  const map: GoldMap = {
    key: source.key,
    title: wardleyMap.title,
    context: source.context,
    sourceFile: source.file,
    // Evolution is DROPPED here, not masked: the field never enters the file.
    nodes: wardleyMap.components.map((c) => ({
      id: c.id,
      label: c.label.name,
      type: c.type === 'anchor' ? ('anchor' as const) : ('component' as const),
      visibility: c.position.visibility.scalar,
    })),
    edges: wardleyMap.relations.map((r) => ({ consumer: r.consumer, supplier: r.supplier })),
  };

  const perStage = new Map<EvolutionStage, number>();
  const candidates: Candidate[] = [];
  for (const component of wardleyMap.components) {
    // Anchors are users, not capabilities: the engine places them with a
    // different strategy (`position-anchor-in-evolution`). Out of scope.
    if (component.type === 'anchor') continue;
    const evolution = component.position.evolution.scalar;
    const stage = stageOf(evolution);
    const rankInBucket = perStage.get(stage) ?? 0;
    perStage.set(stage, rankInBucket + 1);
    candidates.push({
      mapKey: source.key,
      mapIndex,
      rankInBucket,
      goldCase: {
        id: `${source.key}:${component.id}`,
        mapKey: source.key,
        componentId: component.id,
        component: component.label.name,
        // The source maps carry no per-component description. Left empty
        // rather than invented — a guessed description would be a hint no
        // real session has.
        description: '',
        context: source.context,
        date: REFERENCE_DATE,
        truth: { evolution, stage },
      },
    });
  }
  return { map, candidates };
}

/**
 * Stratified, deterministic selection: cycle through the four stages, taking
 * one candidate per stage per round, interleaving the three maps. No sampling,
 * no randomness — the same three maps always produce the same set, and the
 * prefix the pilot runs is balanced across stages by construction.
 */
export function selectCases(candidates: readonly Candidate[], size: number): GoldCase[] {
  const buckets = new Map<EvolutionStage, Candidate[]>();
  for (const stage of STAGE_CYCLE) buckets.set(stage, []);
  for (const candidate of candidates) {
    buckets.get(candidate.goldCase.truth.stage)?.push(candidate);
  }
  // Inside a bucket: alternate the source maps (rank first, map index second),
  // so a prefix of the selection never comes from a single map.
  for (const bucket of buckets.values()) {
    bucket.sort(
      (a, b) =>
        a.rankInBucket - b.rankInBucket ||
        a.mapIndex - b.mapIndex ||
        a.goldCase.id.localeCompare(b.goldCase.id),
    );
  }

  const cursors = new Map<EvolutionStage, number>(STAGE_CYCLE.map((s) => [s, 0]));
  const selected: GoldCase[] = [];
  let exhausted = false;
  while (selected.length < size && !exhausted) {
    exhausted = true;
    for (const stage of STAGE_CYCLE) {
      if (selected.length >= size) break;
      const bucket = buckets.get(stage) ?? [];
      const cursor = cursors.get(stage) ?? 0;
      if (cursor >= bucket.length) continue;
      cursors.set(stage, cursor + 1);
      selected.push(bucket[cursor].goldCase);
      exhausted = false;
    }
  }
  return selected;
}

export async function buildGoldSet(): Promise<GoldSet> {
  const maps: Record<string, GoldMap> = {};
  const candidates: Candidate[] = [];
  for (const [index, source] of SOURCES.entries()) {
    const read = await readSource(source, index);
    maps[source.key] = read.map;
    candidates.push(...read.candidates);
  }
  return {
    generator: 'bench/gold/build-gold-set.mts',
    generatedFrom: SOURCES.map((s) => s.file),
    tolerance: TOLERANCE,
    maps,
    cases: selectCases(candidates, GOLD_SIZE),
  };
}

/** Read the committed reference set. */
export function loadGoldSet(): GoldSet {
  const file = path.join(benchDir, 'gold', 'gold-set.json');
  return JSON.parse(readFileSync(file, 'utf8')) as GoldSet;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const goldSet = await buildGoldSet();
  const outDir = path.join(benchDir, 'gold');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'gold-set.json'), `${JSON.stringify(goldSet, null, 2)}\n`, 'utf8');

  const byStage = new Map<string, number>();
  for (const c of goldSet.cases) {
    byStage.set(c.truth.stage, (byStage.get(c.truth.stage) ?? 0) + 1);
  }
  const lines = [
    `[bench:gold] ${goldSet.cases.length} cases from ${goldSet.generatedFrom.length} maps`,
    `  tolerance : ±${goldSet.tolerance}`,
    `  by stage  : ${[...byStage].map(([s, n]) => `${s}=${n}`).join(' ')}`,
    ...goldSet.cases.map(
      (c, i) =>
        `  ${String(i + 1).padStart(2)}. ${c.id.padEnd(38)} ${c.truth.evolution
          .toFixed(2)
          .padStart(5)} (${c.truth.stage})`,
    ),
    '  written   : bench/gold/gold-set.json',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}
