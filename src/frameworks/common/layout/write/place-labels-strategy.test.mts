import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlaceLabelsStrategy } from './place-labels-strategy.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx = {} as RequestContext;

const map = WardleyMapSchema.parse({
  title: 'Tea shop',
  components: [
    { id: 'user', label: { name: 'User', position: { dx: -100, dy: 0 } }, type: 'anchor',
      position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.05 } } },
    { id: 'pay', label: { name: 'Pay', position: { dx: 20, dy: 25 } }, type: 'component', subtype: 'functional',
      position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.8 } } },
  ],
  relations: [{ id: 'r1', consumer: 'user', supplier: 'pay' }],
});

describe('wardley:map:value-chain:prevent-collision:default', () => {
  it('un-pins every label so the render command can place them, preserving node positions', async () => {
    const { result, signals } = await new PlaceLabelsStrategy().evaluate(map, ctx);
    const out = WardleyMapSchema.parse(result);
    for (const c of out.components) {
      assert.equal(c.label.position, undefined, `${c.label.name} label is un-pinned`);
    }
    // Node positions untouched.
    const pay = out.components.find((c) => c.label.name === 'Pay')!;
    assert.equal(pay.position.evolution.scalar, 0.6);
    assert.equal(pay.position.visibility.scalar, 0.8);
    assert.ok(signals.some((s) => s.name === 'labelsUnpinned'));
  });

  it('preserves the upstream view config (input shape) untouched', async () => {
    const withView = { ...map } as Record<string, unknown>;
    withView.renderConfig = { display: { axisEvolution: false, phases: false } };
    const { result } = await new PlaceLabelsStrategy().evaluate(withView, ctx);
    const rc = (result as { renderConfig?: unknown }).renderConfig;
    assert.deepEqual(rc, { display: { axisEvolution: false, phases: false } });
  });

  it('degrades gracefully on a non-canonical input', async () => {
    const { result, insights } = await new PlaceLabelsStrategy().evaluate({ x: 1 }, ctx);
    assert.equal(WardleyMapSchema.parse(result).components.length, 0);
    assert.ok(insights.some((i) => i.text.includes('not a canonical WardleyMap')));
  });
});
