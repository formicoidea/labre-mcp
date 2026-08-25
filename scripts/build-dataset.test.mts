// Fast guard for the dataset harness (scripts/build-dataset.mts).
//
// Four properties, nothing else — the strategies have their own suites:
//   1. determinism: the same seed rebuilds the exact same record, and
//      `--lossless-only` still rebuilds the v1 corpus;
//   2. the lossless generator stays inside the round-trippable dialect;
//   3. the lossy generator declares, for every construction it injects, what
//      the round-trips are supposed to do with it — and both oracles agree;
//   4. the v2 loss oracle BITES in three directions: a declared loss that never
//      happens, a message nothing declared (phantom), and a "silent drop" that
//      turns out to survive.
//
// Run: npx tsx --conditions labre-mcp-dev --test scripts/build-dataset.test.mts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDataset,
  generateBaseMap,
  generateMap,
  mapSeed,
  mulberry32,
  parseArgs,
  runOracles,
  slugify,
  SCALAR_EPSILON,
  type ExpectedLoss,
  type GeneratedMap,
} from './build-dataset.mjs';

const BATCH = 8;
/** How many seeds the dialect-distribution assertions sample. */
const CORPUS = 40;

/** Every seed of the reference run, in order. */
function corpusSeeds(n: number): number[] {
  return Array.from({ length: n }, (_, i) => mapSeed(42, i));
}

/** First generated map that is lossy AND carries a message-bearing loss. */
function firstLossyWithMessage(): GeneratedMap {
  for (const seed of corpusSeeds(64)) {
    const generated = generateMap(seed);
    if (
      generated.mode === 'lossy' &&
      generated.expectedLoss.some((loss) => loss.expectation !== 'silent-drop')
    ) {
      return generated;
    }
  }
  throw new Error('no lossy map with a message-bearing loss in the first 64 seeds');
}

/** First generated map that injected a non-default relation type. */
function firstWithRelationType(): GeneratedMap {
  for (const seed of corpusSeeds(64)) {
    const generated = generateMap(seed);
    if (generated.expectedLoss.some((loss) => loss.construct === 'relation.type')) return generated;
  }
  throw new Error('no map with an injected relation type in the first 64 seeds');
}

describe('build-dataset generator (seeded, deterministic)', () => {
  it('rebuilds an identical record from the same seed', () => {
    for (const seed of [1, 42, 1337, 987654321]) {
      assert.deepEqual(generateMap(seed), generateMap(seed), `seed ${seed} must be stable`);
    }
  });

  it('produces different maps for different seeds', () => {
    assert.notDeepEqual(generateBaseMap(42), generateBaseMap(43));
  });

  it('replays the same PRNG stream from the same state', () => {
    const first = Array.from({ length: 5 }, mulberry32(7));
    const second = Array.from({ length: 5 }, mulberry32(7));
    assert.deepEqual(first, second);
    assert.ok(first.every((v) => v >= 0 && v < 1));
  });

  it('keeps the v1 corpus intact: lossless mode is the base map, untouched', () => {
    // The dialect decisions run on a SIDE PRNG stream, so v2 consumed not a
    // single draw of the v1 generator. `--lossless-only` is bit-for-bit v1.
    for (const seed of corpusSeeds(CORPUS)) {
      const forced = generateMap(seed, 'lossless');
      assert.equal(forced.mode, 'lossless');
      assert.deepEqual(forced.expectedLoss, []);
      assert.deepEqual(forced.map, generateBaseMap(seed));
    }
  });

  it('stays inside the round-trippable dialect', () => {
    for (const seed of corpusSeeds(BATCH)) {
      const map = generateBaseMap(seed);
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
        assert.equal(r.type, 'DependsOn');
        assert.notEqual(r.consumer, r.supplier, 'no self-loop');
        assert.ok(ids.has(r.consumer) && ids.has(r.supplier));
      });
    }
  });
});

describe('build-dataset lossy dialect (v2)', () => {
  it('mixes both dialects across the corpus', () => {
    const modes = corpusSeeds(CORPUS).map((seed) => generateMap(seed).mode);
    const lossy = modes.filter((m) => m === 'lossy').length;
    assert.ok(lossy > 0 && lossy < CORPUS, `expected a mix, got ${lossy}/${CORPUS} lossy`);
    // The draw is a fair coin; anything wildly off would be a generator bug.
    assert.ok(lossy > CORPUS * 0.25 && lossy < CORPUS * 0.75, `lossy share ${lossy}/${CORPUS}`);
  });

  it('declares a loss for every construction it actually injected', () => {
    for (const seed of corpusSeeds(CORPUS)) {
      const { mode, map, expectedLoss } = generateMap(seed);

      if (mode === 'lossless') {
        assert.deepEqual(expectedLoss, [], 'a lossless map declares nothing');
        assert.ok(
          map.components.every(
            (c) =>
              c.subtype === undefined &&
              c.nature === undefined &&
              c.evolvesTo === undefined &&
              c.label.position === undefined,
          ) && map.relations.every((r) => r.type === 'DependsOn'),
          'a lossless map carries no lossy construction',
        );
        continue;
      }

      assert.ok(expectedLoss.length > 0, 'a lossy map declares at least one loss');
      // At most 4 constructions are drawn; `nature` drags `subtype` along, so
      // the distinct-construct count tops out at 5.
      const constructs = new Set(expectedLoss.map((l) => l.construct));
      assert.ok(constructs.size >= 1 && constructs.size <= 5, `constructs: ${[...constructs]}`);

      // Every declaration must be grounded in the map it describes.
      for (const loss of expectedLoss) {
        const component = map.components.find((c) => c.id === loss.target);
        switch (loss.construct) {
          case 'subtype':
            assert.equal(component?.subtype, loss.detail);
            break;
          case 'nature':
            assert.equal(component?.nature, loss.detail);
            assert.equal(component?.subtype, 'functional', 'nature is only legal under a subtype');
            break;
          case 'evolvesTo':
            assert.equal(component?.evolvesTo?.length, 1);
            break;
          case 'label.position':
            assert.ok(component?.label.position !== undefined);
            assert.notEqual(component?.label.position?.dx, 0);
            assert.notEqual(component?.label.position?.dy, 0);
            break;
          case 'relation.type': {
            const relation = map.relations.find((r) => r.id === loss.target);
            assert.equal(relation?.type, loss.detail);
            assert.notEqual(relation?.type, 'DependsOn');
            break;
          }
        }
      }
    }
  });

  it('never declares a loss for what the round-trips actually keep', () => {
    // The two preserved cells of the contract table: a COMPONENT label offset
    // survives OWM (byte-identity proves it) and a relation type survives SVG
    // (the edge stroke colour carries it).
    for (const seed of corpusSeeds(CORPUS)) {
      for (const loss of generateMap(seed).expectedLoss) {
        if (loss.construct === 'label.position' && loss.format === 'owm') {
          assert.equal(loss.detail, 'anchor', 'only the ANCHOR offset is lost in OWM');
        }
        assert.ok(
          !(loss.construct === 'relation.type' && loss.format === 'svg'),
          'SVG recovers the relation type from the stroke colour',
        );
      }
    }
  });
});

describe('build-dataset oracles', () => {
  it(`passes both oracles on ${BATCH} mixed maps`, async () => {
    const { records, summary } = await buildDataset(BATCH, 42, false);
    const failures = records.filter((r) => !r.oracle.pass);
    assert.deepEqual(
      failures.map((r) => `${r.id} [${r.mode}]: ${r.oracle.failures.join(' | ')}`),
      [],
      'every generated map must satisfy its own loss contract',
    );
    assert.ok(summary.lossless.count > 0 && summary.lossy.count > 0, 'the batch must be mixed');
    assert.equal(summary.lossless.pass, summary.lossless.count);
    assert.equal(summary.lossy.pass, summary.lossy.count);
    assert.equal(summary.owmPassRate, 1);
    assert.equal(summary.svgPassRate, 1);
    assert.equal(summary.overallPassRate, 1);
    assert.ok(summary.maxScalarError <= SCALAR_EPSILON, `max drift ${summary.maxScalarError}`);
    assert.equal(records.length, BATCH);
    assert.ok(records.every((r) => r.svg === undefined), 'SVG stays out of the record by default');
    assert.ok(records.every((r) => r.dsl.startsWith('title ')));
  });

  it('observes every declared loss, none of them silently', async () => {
    const { records, summary } = await buildDataset(BATCH, 42, false);
    for (const record of records) {
      assert.equal(
        record.observedLoss.filter((l) => !l.observed).length,
        0,
        `${record.id}: ${record.observedLoss.filter((l) => !l.observed).map((l) => l.construct)}`,
      );
      // `both` expands into one observation per side, so nothing is ever lost.
      assert.ok(record.observedLoss.length >= record.expectedLoss.length, `${record.id}`);
    }
    assert.ok(summary.expectedLosses > 0);
    // The WP5 silent drops (subtype without a symbol, nature, label offsets
    // vanishing through the SVG round-trip) are now declared by emit:svg —
    // a non-zero count here means a loss fell silent again.
    assert.equal(summary.silentDrops, 0, 'every loss must come with a message');
    assert.deepEqual(summary.silentDropsByConstruct, {});
  });

  it('reproduces the v1 contract with --lossless-only', async () => {
    const { records, summary } = await buildDataset(BATCH, 42, false, true);
    assert.equal(summary.lossy.count, 0);
    assert.equal(summary.lossless.count, BATCH);
    assert.equal(summary.overallPassRate, 1);
    assert.ok(records.every((r) => r.expectedLoss.length === 0));
    records.forEach((r, i) => assert.deepEqual(r.map, generateBaseMap(mapSeed(42, i))));
  });

  it('detects a broken round-trip instead of reporting a pass', async () => {
    // A label carrying an OWM-reserved sequence cannot survive the DSL grammar:
    // the harness must FAIL it, which is what makes it an oracle and not a mould.
    const map = generateBaseMap(mapSeed(42, 0));
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

describe('build-dataset loss oracle bites both ways', () => {
  it('fails when a DECLARED loss never happens', async () => {
    // A perfectly lossless map, told to expect an evolvesTo loss on both sides.
    const map = generateBaseMap(mapSeed(42, 0));
    const fabricated: ExpectedLoss[] = [
      { construct: 'evolvesTo', target: map.components[0].id, format: 'both', expectation: 'insight' },
    ];
    const outcome = await runOracles(map, fabricated);
    assert.equal(outcome.oracle.pass, false);
    const missing = outcome.oracle.failures.filter((f) => /none was emitted/.test(f));
    assert.equal(missing.length, 2, `\`both\` must be checked on each side: ${outcome.oracle.failures}`);
    assert.equal(outcome.observedLoss.length, 2);
    assert.ok(outcome.observedLoss.every((l) => !l.observed));
  });

  it('fails on a PHANTOM message nothing declared', async () => {
    // Same map, real losses, but an empty contract: every message the strategies
    // emit about them is now unaccounted for.
    const generated = firstLossyWithMessage();
    const outcome = await runOracles(generated.map, []);
    assert.equal(outcome.oracle.pass, false);
    assert.ok(
      outcome.oracle.failures.some((f) => /^(owm|svg): unexpected (insight|warning):/.test(f)),
      `expected a phantom-message failure, got: ${outcome.oracle.failures}`,
    );
    // …and the very same map passes once its contract is restored.
    const honest = await runOracles(generated.map, generated.expectedLoss);
    assert.deepEqual(honest.oracle.failures, []);
  });

  it('fails when a "silent drop" turns out to survive', async () => {
    // SVG recovers the relation type from the edge stroke colour. Declaring it
    // as silently dropped must be caught, not rubber-stamped.
    const generated = firstWithRelationType();
    const injected = generated.expectedLoss.find((l) => l.construct === 'relation.type');
    assert.ok(injected !== undefined);
    const outcome = await runOracles(generated.map, [
      ...generated.expectedLoss,
      { construct: 'relation.type', target: injected.target, format: 'svg', expectation: 'silent-drop' },
    ]);
    assert.equal(outcome.oracle.pass, false);
    assert.ok(
      outcome.oracle.failures.some((f) => /survived the round-trip/.test(f)),
      `expected a survival failure, got: ${outcome.oracle.failures}`,
    );
  });

  it('records not one message on a lossless map (no ambient parser noise)', async () => {
    // `parse:dsl` used to report the cli-owm DEFAULT `style` + evolution axis
    // labels on EVERY source, which forced the harness to whitelist them. The
    // directive warnings are now raised from the source lines, so a lossless
    // map goes through both round-trips in complete silence — no whitelist.
    const outcome = await runOracles(generateBaseMap(mapSeed(42, 3)));
    assert.deepEqual(outcome.oracle.failures, []);
    assert.deepEqual(outcome.owmStats.parseWarnings, []);
    assert.deepEqual(outcome.owmStats.emitInsights, []);
  });
});

describe('build-dataset CLI parsing', () => {
  it('defaults to 200 maps on seed 42, mixed dialect, without the SVG', () => {
    assert.deepEqual(parseArgs([]), {
      count: 200,
      seed: 42,
      withSvg: false,
      losslessOnly: false,
    });
  });

  it('reads --count, --seed, --with-svg and --lossless-only', () => {
    assert.deepEqual(parseArgs(['--count', '50', '--seed', '7', '--with-svg', '--lossless-only']), {
      count: 50,
      seed: 7,
      withSvg: true,
      losslessOnly: true,
    });
  });

  it('accepts the --flag=value form too', () => {
    assert.deepEqual(parseArgs(['--count=50', '--seed=7']), {
      count: 50,
      seed: 7,
      withSvg: false,
      losslessOnly: false,
    });
  });

  it('rejects garbage rather than silently defaulting', () => {
    assert.throws(() => parseArgs(['--count', 'many']), /non-negative integer/);
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  });
});
