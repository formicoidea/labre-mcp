import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RenderWardleyMapOwmParseDslStrategy } from './dsl.mjs';
import { RenderWardleyMapOwmEmitDslStrategy } from '../emit/dsl.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx: RequestContext = { projectId: 'p', projectRoot: '/tmp/p', sessionId: 's', domain: 'render' };

const parse = new RenderWardleyMapOwmParseDslStrategy();
const emit = new RenderWardleyMapOwmEmitDslStrategy();

async function parseDsl(dsl: string) {
  const out = await parse.evaluate({ dsl }, ctx);
  assert.equal(out.result.parsed, true);
  assert.ok(out.result.map);
  return out.result;
}

async function emitMap(map: WardleyMap | null): Promise<string> {
  const out = await emit.evaluate(map, ctx);
  assert.equal(out.result.emitted, true);
  return out.result.dsl;
}

describe('render:wardley-map:owm:parse:dsl (real, deterministic)', () => {
  it('projects a hand-written DSL onto the canonical WardleyMap', async () => {
    const { map } = await parseDsl(
      [
        'title Online payments',
        'anchor Merchant [0.95, 0.5]',
        'component Checkout [0.7, 0.6] label [-40, 5]',
        'Merchant->Checkout',
      ].join('\n'),
    );

    assert.equal(map!.title, 'Online payments');
    assert.deepEqual(
      map!.components.map((c) => [c.id, c.label.name, c.type]),
      [
        ['merchant', 'Merchant', 'anchor'],
        ['checkout', 'Checkout', 'component'],
      ],
    );
    // OWM visibility 0.95 (top of the chain) → canonical scalar 0.05 (0 = top).
    assert.equal(map!.components[0].position.visibility.scalar, 0.05);
    assert.equal(map!.components[0].position.evolution.scalar, 0.5);
    // `label [dx, dy]` is only lifted when the source line really carries one.
    assert.deepEqual(map!.components[1].label.position, { dx: -40, dy: 5 });
    assert.equal(map!.components[0].label.position, undefined);
    // `A->B` reads "A consumes B" → consumer = A, supplier = B.
    assert.deepEqual(map!.relations, [
      { id: 'rel-1', consumer: 'merchant', supplier: 'checkout', type: 'DependsOn' },
    ]);
  });

  it('restores declaration order even when anchors and components are interleaved', async () => {
    const { map } = await parseDsl(
      [
        'title Interleaved',
        'component First [0.8, 0.2]',
        'anchor Middle [0.9, 0.4]',
        'component Last [0.3, 0.7]',
      ].join('\n'),
    );
    assert.deepEqual(map!.components.map((c) => c.label.name), ['First', 'Middle', 'Last']);
  });

  it('decodes quoted, line-broken names back to their plain label', async () => {
    const { map } = await parseDsl(
      ['title Wordy', 'component "Accept card payments on \\n the checkout page" [0.7, 0.3]'].join('\n'),
    );
    assert.equal(map!.components[0].label.name, 'Accept card payments on the checkout page');
    assert.equal(map!.components[0].id, 'accept-card-payments-on-the-checkout-page');
  });

  it('deduplicates slug ids and warns on duplicate declarations', async () => {
    const { map, warnings } = await parseDsl(
      ['title Dupes', 'component Payment [0.8, 0.2]', 'component Payment [0.4, 0.6]'].join('\n'),
    );
    assert.deepEqual(map!.components.map((c) => c.id), ['payment', 'payment-2']);
    assert.ok(warnings.some((w) => /duplicate component name/.test(w)), warnings.join('\n'));
  });

  it('ignores every non-projectable OWM construction and reports it in warnings', async () => {
    const { map, warnings } = await parseDsl(
      [
        'title Kitchen sink',
        'style wardley',
        'size [1200, 800]',
        'evolution Novel -> Emerging -> Good -> Best',
        'anchor User [0.95, 0.5]',
        'component Kubernetes [0.6, 0.7]',
        'evolve Kubernetes 0.85',
        'pipeline Kubernetes [0.4, 0.8]',
        'note some insight [0.2, 0.6]',
        'annotation 1 [0.5, 0.4] First milestone',
        'submap Logistics [0.5, 0.5] url(https://example.com)',
        // The vendored UrlExtractionStrategy wants the bracketed form, NOT the
        // `url <name> <link>` spelling documented in OWM_DSL_REFERENCE.
        'url logistics [https://example.com/logistics]',
        'pioneers [0.9, 0.2] [0.2, 0.2]',
        'accelerator AI [0.5, 0.6]',
        'market Cloud [0.4, 0.7]',
        'ecosystem AppStore [0.6, 0.65]',
        'buy Kubernetes',
        'User->Kubernetes',
        'User+>Kubernetes',
        'User->Ghost',
      ].join('\n'),
    );

    // Only the projectable subset survives as components.
    assert.deepEqual(map!.components.map((c) => c.label.name), ['User', 'Kubernetes']);
    assert.equal(map!.relations.length, 1);

    // evolve/pipeline/evolution now PROJECT instead of warning.
    const kube = map!.components[1];
    assert.deepEqual(kube.evolvesTo![0].position.evolution, { scalar: 0.85 });
    assert.equal(kube.pipelineGeometry!.evoStart, 0.4);
    assert.equal(kube.pipelineGeometry!.evoEnd, 0.8);
    // any: input-shape renderConfig rides untyped next to the map (passthrough idiom)
    const labels = (map as any).renderConfig?.style?.background?.phases?.default?.labels;
    assert.deepEqual(labels?.map((l: { text: string }) => l.text), ['Novel', 'Emerging', 'Good', 'Best']);

    // The widened parse output (input-shape renderConfig included) must stay
    // schema-valid — the passthrough shape is a legal INPUT.
    assert.ok(WardleyMapSchema.safeParse(map).success);

    const joined = warnings.join('\n');
    for (const expected of [
      /`style` directive ignored/,
      /`size` directive ignored/,
      /`note` declaration/,
      /`annotation` declaration/,
      /`submap` declaration/,
      /`url` declaration/,
      /attitude zone/,
      /`accelerator`/,
      /`market` line\(s\) ignored/,
      /`ecosystem` line\(s\) ignored/,
      /`buy` line\(s\) ignored/,
      /flow\/future\/past variants have no canonical projection/,
      /is not a declared component/,
    ]) {
      assert.match(joined, expected);
    }
    assert.ok(!/`evolve` directive/.test(joined), joined);
    assert.ok(!/`pipeline` declaration/.test(joined), joined);
  });

  it('projects inertia and (build|buy|outsource) decorators onto the canonical component', async () => {
    const { map } = await parseDsl(
      [
        'title Decorated',
        'component Kettle [0.43, 0.35] inertia',
        'component Power [0.1, 0.7] (outsource)',
      ].join('\n'),
    );
    assert.equal(map!.components[0].inertia, true);
    assert.equal(map!.components[1].inertia, undefined);
    assert.deepEqual(map!.components[1].method, {
      category: 'buying-policy',
      recommendation: 'outsource',
    });
  });

  it('clamps out-of-range coordinates instead of failing the schema', async () => {
    const { map } = await parseDsl(['title Clamp', 'component Wild [1.4, -0.2]'].join('\n'));
    assert.equal(map!.components[0].position.visibility.scalar, 0);
    assert.equal(map!.components[0].position.evolution.scalar, 0);
  });

  it('captures `// key: value` header comments into header, context and map.context', async () => {
    const result = await parseDsl(
      [
        'title Spotify',
        'style plain',
        '// angle: positionnement stratégique',
        '// scope: écosystème complet',
        '// temporality: present',
        '// objective: cartographier la chaîne de valeur',
        '// context: Spotify opère un modèle freemium.',
        '// custom-key: kept raw',
        'component Catalogue [0.5, 0.6]',
        '// after-declaration: ignored (header is closed)',
      ].join('\n'),
    );

    assert.deepEqual(result.header, {
      angle: 'positionnement stratégique',
      scope: 'écosystème complet',
      temporality: 'present',
      objective: 'cartographier la chaîne de valeur',
      context: 'Spotify opère un modèle freemium.',
      'custom-key': 'kept raw',
    });
    // Known keys are projected onto the study Context shape…
    assert.equal(result.context!.title, 'cartographier la chaîne de valeur');
    assert.equal(result.context!.angle, 'positionnement stratégique');
    assert.equal(result.context!.scope, 'écosystème complet');
    assert.equal(result.context!.temporality, 'present');
    // …and the `context:` value lands on the canonical map itself.
    assert.equal(result.map!.context, 'Spotify opère un modèle freemium.');
  });

  it('folds French header-key aliases onto the canonical projections (accents included)', async () => {
    const result = await parseDsl(
      [
        'title T',
        '// contexte: chaine de valeur artisanale',
        '// objectif: comprendre la chaine',
        // `future` on purpose: an accented key that silently missed would leave
        // the DEFAULT (`present`), so this assertion cannot pass vacuously.
        '// temporalité: future',
        '// portée: la boutique uniquement',
        'component A [0.5, 0.5]',
      ].join('\n'),
    );
    // Raw header keeps the source spelling; projections use the canonical keys.
    assert.equal(result.header!['contexte'], 'chaine de valeur artisanale');
    assert.equal(result.header!['temporalité'], 'future');
    assert.equal(result.map!.context, 'chaine de valeur artisanale');
    assert.equal(result.context!.title, 'comprendre la chaine');
    assert.equal(result.context!.temporality, 'future');
    assert.equal(result.context!.scope, 'la boutique uniquement');
  });

  it('keeps reading headers after an `evolution` axis directive', async () => {
    const result = await parseDsl(
      [
        'title T',
        'evolution A->B->C->D',
        '// context: après la directive',
        'component X [0.5, 0.5]',
      ].join('\n'),
    );
    assert.equal(result.map!.context, 'après la directive');
  });

  it('survives an evolution directive with fewer than 4 labels (no crash, phases kept)', async () => {
    const result = await parseDsl(
      ['title T', 'evolution A->B', 'component X [0.5, 0.5]'].join('\n'),
    );
    // any: input-shape renderConfig rides untyped next to the map
    const labels = (result.map as any).renderConfig?.style?.background?.phases?.default?.labels;
    assert.deepEqual(labels, [{ text: 'A' }, { text: 'B' }]);
  });

  it('defaults an invalid header temporality to present, with a warning', async () => {
    const result = await parseDsl(
      ['title T', '// temporality: someday', 'component A [0.5, 0.5]'].join('\n'),
    );
    assert.equal(result.context!.temporality, 'present');
    assert.ok(result.warnings.some((w) => w.includes('someday')));
  });

  it('reports no header fields when the source has none', async () => {
    const result = await parseDsl(['title Bare', 'component A [0.5, 0.5]'].join('\n'));
    assert.equal(result.header, undefined);
    assert.equal(result.context, undefined);
    assert.equal(result.map!.context, undefined);
  });

  it('degrades gracefully when the input carries no `dsl` string', async () => {
    const out = await parse.evaluate({ mock: true, methodId: 'whatever' }, ctx);
    assert.equal(out.result.parsed, false);
    assert.equal(out.result.map, null);
    assert.deepEqual(out.result.warnings, []);
    assert.equal(out.insights.length, 1);
    assert.match(out.insights[0].text, /does not carry a `dsl` string/);
  });
});

// ─── Round-trip invariant (ast-schema.md, render domain § 2.3) ───────────────
//
// (a) parse(emit(m))  — same ids, labels, types and relations; scalars within ±0.01
//                       (the OWM grammar rounds coordinates to 2 decimals).
// (b) emit(parse(emit(m))) === emit(m) — byte-identical.
// (c) parse(...) always yields a map that passes WardleyMapSchema.parse.
//
// Fixture ids are the slug of their label because OWM has NO id concept: parse
// re-derives ids from the labels (documented, unavoidable).

interface Fixture {
  name: string;
  map: WardleyMap;
}

const fixtures: Fixture[] = [
  {
    name: 'anchors + components + relations',
    map: WardleyMapSchema.parse({
      title: 'Online payments',
      components: [
        { id: 'merchant', label: { name: 'Merchant' }, type: 'anchor', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.05 } } },
        { id: 'checkout', label: { name: 'Checkout' }, type: 'component', position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.3 } } },
        { id: 'card-network', label: { name: 'Card Network' }, type: 'component', position: { evolution: { scalar: 0.92 }, visibility: { scalar: 0.75 } } },
      ],
      relations: [
        { id: 'rel-1', consumer: 'merchant', supplier: 'checkout' },
        { id: 'rel-2', consumer: 'checkout', supplier: 'card-network' },
      ],
    }),
  },
  {
    name: 'rich constructs: evolve + inertia + pipeline + method + custom phases',
    map: {
      ...WardleyMapSchema.parse({
        title: 'Rich',
        components: [
          { id: 'user', label: { name: 'User' }, type: 'anchor', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.05 } } },
          {
            id: 'kettle', label: { name: 'Kettle' }, type: 'component', inertia: true,
            position: { evolution: { scalar: 0.35 }, visibility: { scalar: 0.57 } },
            evolvesTo: [{ position: { evolution: { scalar: 0.62 }, visibility: { scalar: 0.57 } } }],
          },
          {
            // `pipeline` type: the renderer refuses pipelineGeometry elsewhere.
            id: 'power', label: { name: 'Power' }, type: 'pipeline',
            method: { category: 'buying-policy', recommendation: 'outsource' },
            position: { evolution: { scalar: 0.7 }, visibility: { scalar: 0.9 } },
            pipelineGeometry: { evoStart: 0.6, evoEnd: 0.85, visStart: 0.9, visEnd: 0.9 },
          },
        ],
        relations: [
          { id: 'rel-1', consumer: 'user', supplier: 'kettle' },
          { id: 'rel-2', consumer: 'kettle', supplier: 'power' },
        ],
      }),
      // Input-shape (V3) renderConfig, attached after the schema parse on purpose
      // (the passthrough idiom — a parsed-shape renderConfig is not re-parsable).
      renderConfig: {
        style: {
          background: {
            phases: {
              default: {
                labels: [{ text: 'Idee' }, { text: 'Artisanat' }, { text: 'Produit' }, { text: 'Utilite' }],
              },
            },
          },
        },
      },
    } as WardleyMap,
  },
  {
    name: 'map context riding as a `// context:` header comment',
    map: WardleyMapSchema.parse({
      title: 'Contextualised',
      context: 'Freemium platform between rights holders and listeners.',
      components: [
        { id: 'listener', label: { name: 'Listener' }, type: 'anchor', position: { evolution: { scalar: 0.85 }, visibility: { scalar: 0.05 } } },
        { id: 'catalogue', label: { name: 'Catalogue' }, type: 'component', position: { evolution: { scalar: 0.63 }, visibility: { scalar: 0.51 } } },
      ],
      relations: [{ id: 'rel-1', consumer: 'listener', supplier: 'catalogue' }],
    }),
  },
  {
    name: 'multi-word labels wrapped with a line break + label offsets',
    map: WardleyMapSchema.parse({
      title: 'Wordy value chain',
      components: [
        { id: 'operations-manager', label: { name: 'Operations Manager' }, type: 'anchor', position: { evolution: { scalar: 0.42 }, visibility: { scalar: 0.02 } } },
        { id: 'accept-card-payments-on-the-checkout-page', label: { name: 'Accept card payments on the checkout page', position: { dx: -40, dy: 5 } }, type: 'component', position: { evolution: { scalar: 0.31 }, visibility: { scalar: 0.44 } } },
        { id: 'reconcile-settlement-files-every-night', label: { name: 'Reconcile settlement files every night', position: { dx: 12, dy: -8 } }, type: 'component', position: { evolution: { scalar: 0.68 }, visibility: { scalar: 0.81 } } },
      ],
      relations: [
        { id: 'rel-1', consumer: 'operations-manager', supplier: 'accept-card-payments-on-the-checkout-page' },
        { id: 'rel-2', consumer: 'accept-card-payments-on-the-checkout-page', supplier: 'reconcile-settlement-files-every-night' },
      ],
    }),
  },
  {
    name: 'subtype / nature carriers at extreme positions 0 and 1',
    map: WardleyMapSchema.parse({
      title: 'Extremes',
      components: [
        { id: 'user', label: { name: 'User' }, type: 'anchor', nature: 'personae', position: { evolution: { scalar: 0 }, visibility: { scalar: 0 } } },
        { id: 'need', label: { name: 'Need' }, type: 'component', subtype: 'userNeed', nature: 'anthropic', position: { evolution: { scalar: 1 }, visibility: { scalar: 1 } } },
        { id: 'capability', label: { name: 'Capability' }, type: 'component', subtype: 'functional', nature: 'activity', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } } },
      ],
      relations: [
        { id: 'rel-1', consumer: 'user', supplier: 'need' },
        { id: 'rel-2', consumer: 'need', supplier: 'capability' },
        { id: 'rel-3', consumer: 'user', supplier: 'capability' },
      ],
    }),
  },
  {
    name: 'anchor declared in the middle, accented labels',
    // NFKD decomposition turns `ç` into `c` + a combining mark, which the slug
    // rule then renders as a separator — `commerc-ant`. That is EXACTLY what the
    // value-chain ACL (src/frameworks/render/wardley-map/acl/value-chain.mts)
    // produces for the same label, and the two id generators must agree.
    map: WardleyMapSchema.parse({
      title: 'Chaîne de valeur',
      components: [
        { id: 'plateforme-de-paiement', label: { name: 'Plateforme de paiement' }, type: 'component', position: { evolution: { scalar: 0.55 }, visibility: { scalar: 0.6 } } },
        { id: 'commerc-ant', label: { name: 'Commerçant' }, type: 'anchor', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0 } } },
        { id: 're-seau-carte-bancaire', label: { name: 'Réseau carte bancaire' }, type: 'component', position: { evolution: { scalar: 0.99 }, visibility: { scalar: 0.99 } } },
      ],
      relations: [
        { id: 'rel-1', consumer: 'commerc-ant', supplier: 'plateforme-de-paiement' },
        { id: 'rel-2', consumer: 'plateforme-de-paiement', supplier: 're-seau-carte-bancaire' },
      ],
    }),
  },
];

function shape(map: WardleyMap) {
  return {
    title: map.title,
    components: map.components.map((c) => [c.id, c.label.name, c.type]),
    relations: map.relations.map((r) => [r.id, r.consumer, r.supplier]),
  };
}

describe('render:wardley-map:owm — parse ⇄ emit round-trip', () => {
  for (const fixture of fixtures) {
    it(`preserves ids, labels, relations and positions — ${fixture.name}`, async () => {
      const dsl = await emitMap(fixture.map);
      const out = await parse.evaluate({ dsl }, ctx);
      assert.equal(out.result.parsed, true);
      const reparsed = out.result.map!;

      // (c) the produced map is canonical.
      assert.ok(WardleyMapSchema.safeParse(reparsed).success, 'reparsed map is schema-valid');

      // (a) identical ids / labels / types / relations.
      assert.deepEqual(shape(reparsed), shape(fixture.map));

      // (a) scalars within ±0.01 (OWM coordinates carry 2 decimals).
      for (const [i, original] of fixture.map.components.entries()) {
        const round = reparsed.components[i];
        assert.ok(
          Math.abs(round.position.evolution.scalar - original.position.evolution.scalar) <= 0.01,
          `${original.id}: evolution ${round.position.evolution.scalar} vs ${original.position.evolution.scalar}`,
        );
        assert.ok(
          Math.abs(round.position.visibility.scalar - original.position.visibility.scalar) <= 0.01,
          `${original.id}: visibility ${round.position.visibility.scalar} vs ${original.position.visibility.scalar}`,
        );
      }
    });

    it(`is byte-identical on the second emit — ${fixture.name}`, async () => {
      const dsl = await emitMap(fixture.map);
      const out = await parse.evaluate({ dsl }, ctx);
      const reemitted = await emitMap(out.result.map);
      // (b) emit(parse(emit(m))) === emit(m)
      assert.equal(reemitted, dsl);
    });
  }
});
