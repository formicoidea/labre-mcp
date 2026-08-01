// Fast guard for the dataset harness (scripts/build-dataset.mts).
//
// Two properties, nothing else — the strategies have their own suites:
//   1. determinism: the same seed rebuilds the exact same canonical map;
//   2. both oracles pass on a small batch, i.e. the generator stays inside the
//      round-trippable dialect.
//
// Run: npx tsx --conditions labre-mcp-dev --test scripts/build-dataset.test.mts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDataset,
  generateMap,
  mapSeed,
  mulberry32,
  parseArgs,
  runOracles,
  slugify,
  SCALAR_EPSILON,
} from './build-dataset.mjs';

const BATCH = 8;

describe('build-dataset generator (seeded, deterministic)', () => {
  it('rebuilds an identical map from the same seed', () => {
    for (const seed of [1, 42, 1337, 987654321]) {
      assert.deepEqual(generateMap(seed), generateMap(seed), `seed ${seed} must be stable`);
    }
  });

  it('produces different maps for different seeds', () => {
    const a = generateMap(42);
    const b = generateMap(43);
    assert.notDeepEqual(a, b);
  });

  it('replays the same PRNG stream from the same state', () => {
    const first = Array.from({ length: 5 }, mulberry32(7));
    const second = Array.from({ length: 5 }, mulberry32(7));
    assert.deepEqual(first, second);
    assert.ok(first.every((v) => v >= 0 && v < 1));
  });

  it('stays inside the round-trippable dialect', () => {
    for (let i = 0; i < BATCH; i += 1) {
      const map = generateMap(mapSeed(42, i));
      assert.ok(map.components.length >= 2 && map.components.length <= 15);
      const ids = new Set(map.components.map((c) => c.id));
      assert.equal(ids.size, map.components.length, 'component ids must be unique');
      for (const c of map.components) {
        assert.equal(c.id, slugify(c.label.name), 'id must be the label slug');
        assert.equal(c.subtype, undefined);
        assert.equal(c.nature, undefined);
        assert.equal(c.evolvesTo, undefined);
        assert.equal(c.label.position, undefined);
        assert.ok(c.position.evolution.scalar >= 0.02 && c.position.evolution.scalar <= 0.98);
        assert.ok(c.position.visibility.scalar >= 0.02 && c.position.visibility.scalar <= 0.98);
      }
      map.relations.forEach((r, n) => {
        assert.equal(r.id, `rel-${n + 1}`, 'relation ids must be positional');
        assert.notEqual(r.consumer, r.supplier, 'no self-loop');
        assert.ok(ids.has(r.consumer) && ids.has(r.supplier));
      });
    }
  });
});

describe('build-dataset oracles', () => {
  it(`passes both oracles on ${BATCH} generated maps`, async () => {
    const { records, summary } = await buildDataset(BATCH, 42, false);
    const failures = records.filter((r) => !r.oracle.pass);
    assert.deepEqual(
      failures.map((r) => `${r.id}: ${r.oracle.failures.join(' | ')}`),
      [],
      'every generated map must round-trip through both oracles',
    );
    assert.equal(summary.owmPassRate, 1);
    assert.equal(summary.svgPassRate, 1);
    assert.equal(summary.overallPassRate, 1);
    assert.ok(summary.maxScalarError <= SCALAR_EPSILON, `max drift ${summary.maxScalarError}`);
    assert.equal(records.length, BATCH);
    assert.ok(records.every((r) => r.svg === undefined), 'SVG stays out of the record by default');
    assert.ok(records.every((r) => r.dsl.startsWith('title ')));
  });

  it('detects a broken round-trip instead of reporting a pass', async () => {
    // A label carrying an OWM-reserved sequence cannot survive the DSL grammar:
    // the harness must FAIL it, which is what makes it an oracle and not a mould.
    const map = generateMap(mapSeed(42, 0));
    const broken = structuredClone(map);
    broken.components[0].label.name = 'Broken -> Label';
    broken.components[0].id = slugify(broken.components[0].label.name);
    for (const relation of broken.relations) {
      if (relation.consumer === map.components[0].id) relation.consumer = broken.components[0].id;
      if (relation.supplier === map.components[0].id) relation.supplier = broken.components[0].id;
    }
    const outcome = await runOracles(broken);
    assert.equal(outcome.oracle.pass, false);
    assert.ok(outcome.oracle.failures.length > 0);
  });

  it('embeds the SVG only when asked', async () => {
    const { records } = await buildDataset(2, 7, true);
    assert.ok(records.every((r) => typeof r.svg === 'string' && r.svg.includes('<svg')));
  });
});

describe('build-dataset CLI parsing', () => {
  it('defaults to 200 maps on seed 42 without the SVG', () => {
    assert.deepEqual(parseArgs([]), { count: 200, seed: 42, withSvg: false });
  });

  it('reads --count, --seed and --with-svg', () => {
    assert.deepEqual(parseArgs(['--count', '50', '--seed', '7', '--with-svg']), {
      count: 50,
      seed: 7,
      withSvg: true,
    });
  });

  it('accepts the --flag=value form too', () => {
    assert.deepEqual(parseArgs(['--count=50', '--seed=7']), { count: 50, seed: 7, withSvg: false });
  });

  it('rejects garbage rather than silently defaulting', () => {
    assert.throws(() => parseArgs(['--count', 'many']), /non-negative integer/);
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  });
});
