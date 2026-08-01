// Unit tests for `render:wardley-map:image:parse:png`.
//
// NO REAL LLM CALL happens here — every test either injects a stub through the
// constructor seam or exercises the pure stage-2 projection. The model's actual
// transcription QUALITY is an eval concern (round-trip dataset), deliberately
// out of scope: what is pinned below is the contract — projection, id
// derivation, relation resolution, and the degradation behaviour on every
// failure mode.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RenderWardleyMapImageParsePngStrategy,
  parseVisionExtraction,
  projectToWardleyMap,
  type VisionExtraction,
} from './png.mjs';
import { RenderWardleyMapImageEmitPngStrategy } from '../emit/png.mjs';
import { decodePng, type DecodedPng } from '#lib/png/decode.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import { computeMapGeometry } from '@formicoidea/wardley-map-renderer';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { LLMCall, LLMCallOptions } from '#types/llm.mjs';
import { setLLMCallForTesting, resetLLMRegistryCache } from '#lib/llm/registry.mjs';
import { createAgentSdkProvider } from '#lib/llm/providers/agent-sdk-provider.mjs';
import { createCopilotSdkProvider } from '#lib/llm/providers/copilot-sdk-provider.mjs';
import { createHttpApiProvider } from '#lib/llm/providers/http-api-provider.mjs';

const requestCtx: RequestContext = {
  projectId: 't', projectRoot: '/t', sessionId: 's', domain: 'render',
};

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';

/** A plausible answer for a small tea-shop map, framed exactly as the prompt
 *  asks (markers + JSON, nothing else). */
const TEA_SHOP = {
  title: 'Tea Shop',
  components: [
    { name: 'Public', type: 'anchor', evolution: 0.85, visibility: 0.05 },
    { name: 'Cup of Tea', type: 'component', evolution: 0.68, visibility: 0.2 },
    { name: 'Hot Water', type: 'component', evolution: 0.78, visibility: 0.45 },
    { name: 'Kettle', type: 'component', evolution: 0.62, visibility: 0.6 },
    { name: 'Power', type: 'component', evolution: 0.95, visibility: 0.85 },
  ],
  relations: [
    { consumer: 'Public', supplier: 'Cup of Tea' },
    { consumer: 'Cup of Tea', supplier: 'Hot Water' },
    { consumer: 'Hot Water', supplier: 'Kettle' },
    { consumer: 'Kettle', supplier: 'Power' },
  ],
};

function framed(payload: unknown): string {
  return `MAP_START\n${JSON.stringify(payload, null, 2)}\nMAP_END`;
}

/** Stub LLM that always answers `response`, recording what it was called with. */
function stubLLM(response: string): { call: LLMCall; seen: { prompt?: string; opts?: LLMCallOptions } } {
  const seen: { prompt?: string; opts?: LLMCallOptions } = {};
  const call: LLMCall = async (prompt, _vars, opts) => {
    seen.prompt = prompt;
    seen.opts = opts;
    return response;
  };
  return { call, seen };
}

// ── Stage 1: the strict intermediate ───────────────────────────────────────

describe('parseVisionExtraction', () => {
  it('accepts a clean object and defaults type to component', () => {
    const x = parseVisionExtraction(
      '{"components":[{"name":"A","evolution":0.1,"visibility":0.2}]}',
    );
    assert.equal(x.title, '');
    assert.equal(x.components[0].type, 'component');
    assert.deepEqual(x.relations, []);
  });

  it('tolerates prose and code fences around the JSON', () => {
    const x = parseVisionExtraction('Here you go:\n```json\n' + JSON.stringify(TEA_SHOP) + '\n```');
    assert.equal(x.title, 'Tea Shop');
    assert.equal(x.components.length, 5);
  });

  it('strips unknown keys a chatty model adds', () => {
    const x = parseVisionExtraction(
      '{"title":"T","confidence":0.7,"components":[{"name":"A","evolution":0,"visibility":0,"why":"guess"}]}',
    );
    assert.ok(!('confidence' in x));
    assert.ok(!('why' in x.components[0]));
  });

  it('rejects an out-of-range scalar', () => {
    assert.throws(() =>
      parseVisionExtraction('{"components":[{"name":"A","evolution":1.4,"visibility":0.2}]}'),
    );
  });

  it('rejects a component with no position', () => {
    assert.throws(() => parseVisionExtraction('{"components":[{"name":"A"}]}'));
  });

  it('throws when the response holds no JSON object', () => {
    assert.throws(() => parseVisionExtraction('I could not read this image, sorry.'));
  });
});

// ── Stage 2: the deterministic projection ──────────────────────────────────

describe('projectToWardleyMap', () => {
  it('slugifies ids, copies scalars verbatim and numbers relations', () => {
    const { map, warnings } = projectToWardleyMap(parseVisionExtraction(JSON.stringify(TEA_SHOP)));
    assert.ok(map !== null);
    assert.deepEqual(warnings, []);
    assert.equal(map.title, 'Tea Shop');
    assert.deepEqual(
      map.components.map((c) => c.id),
      ['public', 'cup-of-tea', 'hot-water', 'kettle', 'power'],
    );
    assert.equal(map.components[0].type, 'anchor');
    assert.equal(map.components[1].type, 'component');
    // No visibility flip: the prompt already asks for the canonical screen-space
    // convention (0 = top / most visible).
    assert.equal(map.components[1].position.evolution.scalar, 0.68);
    assert.equal(map.components[1].position.visibility.scalar, 0.2);
    assert.deepEqual(
      map.relations.map((r) => [r.id, r.consumer, r.supplier]),
      [
        ['rel-1', 'public', 'cup-of-tea'],
        ['rel-2', 'cup-of-tea', 'hot-water'],
        ['rel-3', 'hot-water', 'kettle'],
        ['rel-4', 'kettle', 'power'],
      ],
    );
  });

  it('projects the optional decorators: color, inertia, evolvesTo, pipeline', () => {
    const { map, warnings } = projectToWardleyMap({
      title: 'Decorated',
      components: [
        { name: 'Kettle', type: 'component', evolution: 0.35, visibility: 0.6, color: '#e05252', inertia: true, evolvesTo: 0.68 },
        { name: 'Power', type: 'component', evolution: 0.7, visibility: 0.9, pipeline: { evoStart: 0.8, evoEnd: 0.55 } },
      ],
      relations: [],
    });
    assert.equal(warnings.length, 0);
    const [kettle, power] = map!.components;
    assert.equal(kettle.color, '#e05252');
    assert.equal(kettle.inertia, true);
    // The movement arrow stays on the component's row; the renderer draws the
    // inertia wall from the TARGET's flag, so it is mirrored there.
    assert.deepEqual(kettle.evolvesTo![0].position, {
      evolution: { scalar: 0.68 },
      visibility: { scalar: 0.6 },
    });
    assert.equal(kettle.evolvesTo![0].inertia, true);
    // A pipeline band promotes the node to the canonical `pipeline` type
    // (validateMap refuses the geometry on any other type).
    assert.equal(power.type, 'pipeline');
    // Pipeline edges are normalised left-to-right at the component's row.
    assert.deepEqual(power.pipelineGeometry, {
      evoStart: 0.55,
      evoEnd: 0.8,
      visStart: 0.9,
      visEnd: 0.9,
    });
  });

  it('drops a non-hex color with a warning instead of letting the renderer paint it black', () => {
    // resolveColor falls back to #000000 for anything that is neither hex nor
    // a known Tailwind name — forwarding "red" verbatim would silently repaint
    // the component. The deterministic stage is the enforcement point.
    const { map, warnings } = projectToWardleyMap({
      title: 'T',
      components: [
        { name: 'Red One', type: 'component', evolution: 0.5, visibility: 0.4, color: 'red' },
        { name: 'Kept', type: 'component', evolution: 0.6, visibility: 0.5, color: '#00AA55' },
      ],
      relations: [],
    });
    const [redOne, kept] = map!.components;
    assert.equal(redOne.color, undefined);
    assert.equal(kept.color, '#00AA55');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /color "red" on "Red One" dropped/);
  });

  it('rejects a pipeline band on an anchor and stays render-valid', () => {
    const { map, warnings } = projectToWardleyMap({
      title: 'T',
      components: [
        { name: 'User', type: 'anchor', evolution: 0.5, visibility: 0.05, pipeline: { evoStart: 0.2, evoEnd: 0.6 } },
      ],
      relations: [],
    });
    assert.equal(map!.components[0].pipelineGeometry, undefined);
    assert.ok(warnings.some((w) => w.includes('pipeline band on anchor')));
    assert.ok(!warnings.some((w) => w.startsWith('render-validity:')), warnings.join('; '));
  });

  it('de-duplicates ids of repeated labels and warns', () => {
    const { map, warnings } = projectToWardleyMap(
      parseVisionExtraction(
        '{"components":[' +
          '{"name":"Data","evolution":0.1,"visibility":0.1},' +
          '{"name":"Data","evolution":0.9,"visibility":0.9}]}',
      ),
    );
    assert.ok(map !== null);
    assert.deepEqual(map.components.map((c) => c.id), ['data', 'data-2']);
    assert.ok(warnings.some((w) => /appears more than once/.test(w)));
  });

  it('falls back to "node" for a label with no alphanumerics', () => {
    const { map } = projectToWardleyMap(
      parseVisionExtraction('{"components":[{"name":"???","evolution":0,"visibility":0}]}'),
    );
    assert.equal(map?.components[0].id, 'node');
  });

  it('resolves relation names case- and whitespace-insensitively', () => {
    const { map, warnings } = projectToWardleyMap(
      parseVisionExtraction(
        '{"components":[' +
          '{"name":"Cup of Tea","evolution":0.6,"visibility":0.2},' +
          '{"name":"Kettle","evolution":0.6,"visibility":0.6}],' +
          '"relations":[{"consumer":"  cup of tea ","supplier":"KETTLE"}]}',
      ),
    );
    assert.deepEqual(warnings, []);
    assert.deepEqual(map?.relations, [
      { id: 'rel-1', consumer: 'cup-of-tea', supplier: 'kettle', type: 'DependsOn' },
    ]);
  });

  it('drops a relation naming an untranscribed component, with a warning', () => {
    const { map, warnings } = projectToWardleyMap(
      parseVisionExtraction(
        '{"components":[{"name":"Kettle","evolution":0.6,"visibility":0.6}],' +
          '"relations":[{"consumer":"Ghost","supplier":"Kettle"},' +
          '{"consumer":"Kettle","supplier":"Phantom"}]}',
      ),
    );
    assert.ok(map !== null);
    assert.deepEqual(map.relations, []);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((w) => /relation dropped/.test(w)));
    assert.ok(warnings.some((w) => /"Ghost"/.test(w)));
    assert.ok(warnings.some((w) => /"Phantom"/.test(w)));
  });

  it('drops a self-relation, with a warning', () => {
    const { map, warnings } = projectToWardleyMap(
      parseVisionExtraction(
        '{"components":[{"name":"Kettle","evolution":0.6,"visibility":0.6}],' +
          '"relations":[{"consumer":"Kettle","supplier":"Kettle"}]}',
      ),
    );
    assert.deepEqual(map?.relations, []);
    assert.ok(warnings.some((w) => /depends on itself/.test(w)));
  });

  it('produces an empty but valid map when nothing was legible', () => {
    const { map, warnings } = projectToWardleyMap(parseVisionExtraction('{}'));
    assert.ok(map !== null);
    assert.equal(map.title, '');
    assert.deepEqual(map.components, []);
    assert.deepEqual(warnings, []);
  });
});

// ── Pixel arbitration of declared colors ───────────────────────────────────

/** White canvas with `paint` overriding some pixels — a DecodedPng needs no
 *  encoding round-trip, the struct is enough. */
function syntheticPng(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number] | null,
): DecodedPng {
  const pixels = Buffer.alloc(width * height * 4, 0xff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = paint(x, y);
      if (p === null) continue;
      const i = (y * width + x) * 4;
      pixels[i] = p[0];
      pixels[i + 1] = p[1];
      pixels[i + 2] = p[2];
    }
  }
  return { width, height, pixels };
}

/** Solid disk of `color` centred on (cx, cy). */
function disk(color: [number, number, number], cx: number, cy: number, r = 4) {
  return (x: number, y: number): [number, number, number] | null =>
    (x - cx) ** 2 + (y - cy) ** 2 <= r * r ? color : null;
}

function dotComponent(over: Record<string, unknown>): VisionExtraction['components'][number] {
  return { name: 'Dot', type: 'component', evolution: 0.5, visibility: 0.5, ...over };
}

describe('projectToWardleyMap · color sampling', () => {
  it('keeps a declared color confirmed by a solid-filled dot', () => {
    const png = syntheticPng(40, 40, disk([0xe0, 0x52, 0x52], 20, 20));
    const { map, warnings } = projectToWardleyMap(
      { title: '', components: [dotComponent({ color: '#e05252', px: 20, py: 20 })], relations: [] },
      png,
    );
    assert.equal(map!.components[0].color, '#e05252');
    assert.deepEqual(warnings, []);
  });

  it('confirms a declared color from anti-aliased white-blended tints alone', () => {
    // No pure pixel anywhere — only a 60% coverage tint of #e05252, which is
    // what a 1px-stroked ring actually looks like: 255 − 0.6·(255−c) per
    // channel → (236, 151, 151).
    const tint: [number, number, number] = [236, 151, 151];
    const png = syntheticPng(40, 40, (x, y) => (y === 15 && x >= 18 && x <= 22 ? tint : null));
    const { map, warnings } = projectToWardleyMap(
      { title: '', components: [dotComponent({ color: '#e05252', px: 20, py: 20 })], relations: [] },
      png,
    );
    assert.equal(map!.components[0].color, '#e05252');
    assert.deepEqual(warnings, []);
  });

  it('lets the sampled pixels win over a diverging declaration, with a warning', () => {
    const png = syntheticPng(40, 40, disk([0x33, 0x66, 0xcc], 20, 20));
    const { map, warnings } = projectToWardleyMap(
      { title: '', components: [dotComponent({ color: '#e05252', px: 20, py: 20 })], relations: [] },
      png,
    );
    assert.equal(map!.components[0].color, '#3366cc');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /declared #e05252 diverges .* sampled #3366cc wins/);
  });

  it('vetoes a color declared on a default-styled (black-stroked) dot', () => {
    // Greys are what a black default stroke anti-aliases into: chroma 0, and
    // inconsistent with any chromatic declaration.
    const png = syntheticPng(40, 40, disk([80, 80, 80], 20, 20));
    const { map, warnings } = projectToWardleyMap(
      { title: '', components: [dotComponent({ color: '#e05252', px: 20, py: 20 })], relations: [] },
      png,
    );
    assert.equal(map!.components[0].color, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /default-styled dot/);
  });

  it('replaces a non-hex declaration with the sampled value when the dot is localised', () => {
    const png = syntheticPng(40, 40, disk([0x00, 0xaa, 0x55], 20, 20));
    const { map, warnings } = projectToWardleyMap(
      { title: '', components: [dotComponent({ color: 'green', px: 20, py: 20 })], relations: [] },
      png,
    );
    assert.equal(map!.components[0].color, '#00aa55');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"green" .* not #rrggbb: replaced by #00aa55/);
  });

  it('keeps the declared color when px/py fall outside the image', () => {
    const png = syntheticPng(40, 40, () => null);
    const { map, warnings } = projectToWardleyMap(
      { title: '', components: [dotComponent({ color: '#e05252', px: 999, py: 999 })], relations: [] },
      png,
    );
    assert.equal(map!.components[0].color, '#e05252');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /outside the image/);
  });
});

// ── The round-trip oracle ──────────────────────────────────────────────────
//
// The one place a DETERMINISTIC oracle exists for parse:png: a color emitted
// by the REAL emit:png strategy must come back exactly through the sampler,
// with px/py computed from the renderer's own geometry — no LLM anywhere.
// (The rest of parse:png quality remains an eval question, per the header.)

describe('pixel-color oracle: emit:png → sample → exact color round-trip', () => {
  const oracleMap = WardleyMapSchema.parse({
    title: 'Oracle',
    components: [
      { id: 'kettle', label: { name: 'Kettle' }, type: 'component', position: { evolution: { scalar: 0.35 }, visibility: { scalar: 0.6 } }, color: '#e05252' },
      { id: 'power', label: { name: 'Power' }, type: 'component', position: { evolution: { scalar: 0.7 }, visibility: { scalar: 0.85 } } },
    ],
    relations: [],
  });

  // Render once for the whole suite (resvg + font loading dominate the cost).
  let fixture: Promise<{ png: DecodedPng; centers: Map<string, { x: number; y: number }> }> | null = null;
  function renderOnce() {
    fixture ??= (async () => {
      const emitted = await new RenderWardleyMapImageEmitPngStrategy().evaluate(oracleMap, requestCtx);
      assert.equal(emitted.result.rendered, true);
      const png = decodePng(Buffer.from(emitted.result.pngBase64, 'base64'));
      // The PNG is rasterised at fitTo-width = canvasWidth, so SVG coordinates
      // ARE pixel coordinates: the renderer's own node geometry gives px/py.
      const centers = new Map(
        computeMapGeometry(oracleMap).nodes.map((n) => [n.component.id, { x: n.cx, y: n.cy }]),
      );
      return { png, centers };
    })();
    return fixture;
  }

  function kettleExtraction(px: number, py: number, color = '#e05252'): VisionExtraction {
    return {
      title: 'Oracle',
      components: [
        { name: 'Kettle', type: 'component', evolution: 0.35, visibility: 0.6, color, px, py },
      ],
      relations: [],
    };
  }

  it('recovers the exact emitted color, deterministically, without a model', async () => {
    const { png, centers } = await renderOnce();
    const k = centers.get('kettle')!;
    const { map, warnings } = projectToWardleyMap(kettleExtraction(k.x, k.y), png);
    assert.equal(map!.components[0].color, '#e05252');
    assert.deepEqual(warnings, []);
  });

  it('stays exact when the model mislocates the dot by a few pixels', async () => {
    const { png, centers } = await renderOnce();
    const k = centers.get('kettle')!;
    const { map, warnings } = projectToWardleyMap(kettleExtraction(k.x + 4, k.y - 3), png);
    assert.equal(map!.components[0].color, '#e05252');
    assert.deepEqual(warnings, []);
  });

  it('flags a strong divergence and lets the sampled pixels win', async () => {
    const { png, centers } = await renderOnce();
    const k = centers.get('kettle')!;
    const { map, warnings } = projectToWardleyMap(kettleExtraction(k.x, k.y, '#3355ff'), png);
    const color = map!.components[0].color!;
    assert.notEqual(color, '#3355ff');
    assert.match(color, /^#[0-9a-f]{6}$/);
    // The dot really is red: the sampled tint must be red-dominant.
    assert.ok(parseInt(color.slice(1, 3), 16) > parseInt(color.slice(5, 7), 16), color);
    assert.ok(warnings.some((w) => /declared #3355ff diverges/.test(w)), warnings.join('; '));
  });

  it('vetoes a color hallucinated on the default-styled component', async () => {
    const { png, centers } = await renderOnce();
    const p = centers.get('power')!;
    const { map, warnings } = projectToWardleyMap(
      {
        title: 'Oracle',
        components: [
          { name: 'Power', type: 'component', evolution: 0.7, visibility: 0.85, color: '#e05252', px: p.x, py: p.y },
        ],
        relations: [],
      },
      png,
    );
    assert.equal(map!.components[0].color, undefined);
    assert.ok(warnings.some((w) => /default-styled dot/.test(w)), warnings.join('; '));
  });
});

// ── The strategy ───────────────────────────────────────────────────────────

describe('strategy.evaluate', () => {
  afterEach(() => {
    resetLLMRegistryCache();
  });

  it('transcribes a map from an injected vision LLM', async () => {
    const { call } = stubLLM(framed(TEA_SHOP));
    const strat = new RenderWardleyMapImageParsePngStrategy({ llmCall: call });
    const res = await strat.evaluate({ pngBase64: PNG_B64 }, requestCtx);

    assert.equal(res.result.parsed, true);
    assert.equal(res.result.map?.title, 'Tea Shop');
    assert.deepEqual(res.result.warnings, []);
    assert.equal(res.signals.find((s) => s.name === 'llm-used')?.value, true);
    assert.equal(res.signals.find((s) => s.name === 'componentCount')?.value, 5);
    assert.equal(res.signals.find((s) => s.name === 'relationCount')?.value, 4);
  });

  it('sends the image on the LLM image channel with the split prompt', async () => {
    const { call, seen } = stubLLM(framed(TEA_SHOP));
    const strat = new RenderWardleyMapImageParsePngStrategy({ llmCall: call });
    await strat.evaluate({ pngBase64: PNG_B64 }, requestCtx);

    assert.deepEqual(seen.opts?.images, [{ mediaType: 'image/png', base64: PNG_B64 }]);
    // Split prompt: the invariant instructions ride the system slot, and the
    // user message carries the interpolated mediaType.
    assert.ok((seen.opts?.systemPrompt ?? '').length > 0);
    assert.ok(!/\{\{/.test(seen.opts?.systemPrompt ?? ''));
    assert.ok(seen.prompt?.includes('image/png'));
    assert.ok(!/\{\{/.test(seen.prompt ?? ''));
  });

  it('keeps the model caveat in the insights, never in the map', async () => {
    const { call } = stubLLM(framed(TEA_SHOP));
    const strat = new RenderWardleyMapImageParsePngStrategy({ llmCall: call });
    const res = await strat.evaluate({ pngBase64: PNG_B64 }, requestCtx);

    assert.ok(res.insights.some((i) => /vision model/.test(i.text)));
    // Reasoning trace captured, not discarded (ARCH-22).
    assert.equal(res.reasoning.length, 1);
    const serialised = JSON.stringify(res.result.map);
    assert.ok(!/confidence/i.test(serialised));
    assert.ok(!/uncertain/i.test(serialised));
  });

  it('degrades on malformed JSON: parsed false, warning, no throw', async () => {
    const { call } = stubLLM('MAP_START\nnot json at all\nMAP_END');
    const strat = new RenderWardleyMapImageParsePngStrategy({ llmCall: call });
    const res = await strat.evaluate({ pngBase64: PNG_B64 }, requestCtx);

    assert.equal(res.result.parsed, false);
    assert.equal(res.result.map, null);
    assert.ok(res.result.warnings.some((w) => /not a valid transcription/.test(w)));
    assert.ok(res.insights.some((i) => /cannot parse the image/.test(i.text)));
  });

  it('degrades when the model answers without the markers but with valid JSON', async () => {
    const { call } = stubLLM(`Sure! ${JSON.stringify(TEA_SHOP)}`);
    const strat = new RenderWardleyMapImageParsePngStrategy({ llmCall: call });
    const res = await strat.evaluate({ pngBase64: PNG_B64 }, requestCtx);

    // Raw-response fallback: the markers are a convenience, not a hard gate.
    assert.equal(res.result.parsed, true);
    assert.equal(res.result.map?.components.length, 5);
  });

  it('warns and ignores relations naming unknown components', async () => {
    const { call } = stubLLM(
      framed({
        title: 'Partial',
        components: [{ name: 'Kettle', type: 'component', evolution: 0.6, visibility: 0.6 }],
        relations: [{ consumer: 'Ghost', supplier: 'Kettle' }],
      }),
    );
    const strat = new RenderWardleyMapImageParsePngStrategy({ llmCall: call });
    const res = await strat.evaluate({ pngBase64: PNG_B64 }, requestCtx);

    assert.equal(res.result.parsed, true);
    assert.deepEqual(res.result.map?.relations, []);
    assert.equal(res.result.map?.components.length, 1);
    assert.ok(res.result.warnings.some((w) => /relation dropped/.test(w)));
    assert.ok(res.insights.some((i) => /partially transcribed/i.test(i.text)));
  });

  it('keeps declared colors when the source PNG cannot be decoded for sampling', async () => {
    // PNG_B64 is a deliberately truncated PNG: decodable enough to be sent to
    // the (stubbed) model, not enough for pixel sampling — the declared color
    // must survive, with a degradation warning.
    const { call } = stubLLM(
      framed({
        title: 'T',
        components: [
          { name: 'A', type: 'component', evolution: 0.5, visibility: 0.5, color: '#e05252', px: 10, py: 10 },
        ],
        relations: [],
      }),
    );
    const strat = new RenderWardleyMapImageParsePngStrategy({ llmCall: call });
    const res = await strat.evaluate({ pngBase64: PNG_B64 }, requestCtx);
    assert.equal(res.result.parsed, true);
    assert.equal(res.result.map?.components[0].color, '#e05252');
    assert.ok(
      res.result.warnings.some((w) => /color sampling unavailable/.test(w)),
      res.result.warnings.join('; '),
    );
  });

  it('degrades gracefully when the LLM call itself fails', async () => {
    const strat = new RenderWardleyMapImageParsePngStrategy({
      llmCall: async () => { throw new Error('offline'); },
    });
    const res = await strat.evaluate({ pngBase64: PNG_B64 }, requestCtx);

    assert.equal(res.result.parsed, false);
    assert.ok(res.result.warnings.some((w) => /failed or returned nothing/.test(w)));
  });

  it('degrades gracefully on a non-{ pngBase64 } input', async () => {
    const strat = new RenderWardleyMapImageParsePngStrategy({
      llmCall: async () => { throw new Error('must not be called'); },
    });
    for (const bad of [undefined, null, {}, { pngBase64: '' }, { pngBase64: 42 }, 'a string']) {
      const res = await strat.evaluate(bad, requestCtx);
      assert.equal(res.result.parsed, false, `input ${JSON.stringify(bad)} should not parse`);
      assert.equal(res.result.map, null);
      assert.deepEqual(res.result.warnings, ['input is not { pngBase64: string }']);
      assert.equal(res.signals.find((s) => s.name === 'input-valid')?.value, false);
    }
  });

  it('resolves its LLM from the registry under the "render-image-parse-png" id', async () => {
    const { call, seen } = stubLLM(framed(TEA_SHOP));
    setLLMCallForTesting('render-image-parse-png', 'vision', call);
    // No constructor injection: the strategy must go through the registry.
    const res = await new RenderWardleyMapImageParsePngStrategy().evaluate(
      { pngBase64: PNG_B64 },
      requestCtx,
    );
    assert.equal(res.result.parsed, true);
    assert.deepEqual(seen.opts?.images, [{ mediaType: 'image/png', base64: PNG_B64 }]);
  });
});

// ── Providers without an image channel fail cleanly ────────────────────────

describe('vision capability across providers', () => {
  it('http-api advertises vision and returns a callable', () => {
    const p = createHttpApiProvider({ kind: 'http-api', baseUrl: 'https://example.com/v1' });
    assert.equal(p.supports.vision, true);
    assert.equal(typeof p.vision({ provider: 'x', model: 'some-vision-model' }), 'function');
  });

  it('agent-sdk refuses image input with an explicit message', () => {
    const p = createAgentSdkProvider();
    assert.equal(p.supports.vision, false);
    assert.throws(
      () => p.vision({ provider: 'x', model: 'claude-sonnet-4-6' }),
      /Provider "agent-sdk" does not support image input/,
    );
  });

  it('copilot-sdk refuses image input with an explicit message', () => {
    const p = createCopilotSdkProvider({ kind: 'copilot-sdk', authEnv: 'COPILOT_GITHUB_TOKEN' });
    assert.equal(p.supports.vision, false);
    assert.throws(
      () => p.vision({ provider: 'x', model: 'gpt-5' }),
      /Provider "copilot-sdk" does not support image input/,
    );
  });
});
