import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WardleyMapValueChainOrganizedYPositionDefaultStrategy } from './default.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx = {} as RequestContext;

// A small chain: anchor → two needs (same depth) → one capability.
const chain = WardleyMapSchema.parse({
  title: 'Tea shop',
  components: [
    { id: 'user', label: { name: 'User', position: { dx: -100, dy: 0 } }, type: 'anchor',
      position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } } },
    { id: 'order', label: { name: 'Order' }, type: 'component', subtype: 'userNeed',
      position: { evolution: { scalar: 0.4 }, visibility: { scalar: 0.5 } } },
    { id: 'browse', label: { name: 'Browse' }, type: 'component', subtype: 'userNeed',
      position: { evolution: { scalar: 0.4 }, visibility: { scalar: 0.5 } } }, // same X as order → collision
    { id: 'pay', label: { name: 'Pay' }, type: 'component', subtype: 'functional',
      position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.5 } } },
  ],
  relations: [
    { id: 'r1', consumer: 'user', supplier: 'order' },
    { id: 'r2', consumer: 'user', supplier: 'browse' },
    { id: 'r3', consumer: 'order', supplier: 'pay' },
  ],
});

const byId = (m: ReturnType<typeof WardleyMapSchema.parse>) => new Map(m.components.map((c) => [c.id, c]));

describe('wardley:map:value-chain:organized-y-position:default', () => {
  it('lays nodes into depth bands (same depth shares a Y level, parent strictly above child)', async () => {
    const strategy = new WardleyMapValueChainOrganizedYPositionDefaultStrategy();
    const map = WardleyMapSchema.parse((await strategy.evaluate(chain, ctx)).result);
    const m = byId(map);
    const y = (id: string) => m.get(id)!.position.visibility.scalar;

    // Same-depth needs share a band; deeper nodes sit strictly lower.
    assert.equal(y('order'), y('browse'), 'same-depth needs share a Y band');
    assert.ok(y('user') < y('order'), 'anchor above its needs');
    assert.ok(y('order') < y('pay'), 'need above its capability');
    // Every dependency renders top-down.
    for (const r of map.relations)
      assert.ok(y(r.consumer) < y(r.supplier), `edge ${r.consumer}->${r.supplier} top-down`);
  });

  it('de-collides X within a band (two same-depth nodes never share a pixel)', async () => {
    const strategy = new WardleyMapValueChainOrganizedYPositionDefaultStrategy();
    const map = WardleyMapSchema.parse((await strategy.evaluate(chain, ctx)).result);
    const m = byId(map);
    const dx = Math.abs(m.get('order')!.position.evolution.scalar - m.get('browse')!.position.evolution.scalar);
    assert.ok(dx >= 0.02 - 1e-9, `same-band nodes separated on X (got ${dx})`);
  });

  it('orders a band under its parents (barycentre): a child is not on the opposite side', async () => {
    // user(0.8) → a(child); user is the only parent, so the child sits under it.
    const m2 = WardleyMapSchema.parse({
      title: 't',
      components: [
        { id: 'root', label: { name: 'R' }, type: 'anchor', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } } },
        { id: 'p', label: { name: 'P' }, type: 'component', position: { evolution: { scalar: 0.8 }, visibility: { scalar: 0.5 } } },
        { id: 'q', label: { name: 'Q' }, type: 'component', position: { evolution: { scalar: 0.2 }, visibility: { scalar: 0.5 } } },
        // child c depends on p (right) only — its own X is far left (0.1).
        { id: 'c', label: { name: 'C' }, type: 'component', position: { evolution: { scalar: 0.1 }, visibility: { scalar: 0.5 } } },
      ],
      relations: [
        { id: 'r1', consumer: 'root', supplier: 'p' },
        { id: 'r2', consumer: 'root', supplier: 'q' },
        { id: 'r3', consumer: 'p', supplier: 'c' },
      ],
    });
    const out = byId(WardleyMapSchema.parse((await new WardleyMapValueChainOrganizedYPositionDefaultStrategy().evaluate(m2, ctx)).result));
    // c is the only node in its band and its parent p is on the right → c is
    // pulled toward p, NOT left where its incoming X was.
    assert.ok(out.get('c')!.position.evolution.scalar > out.get('q')!.position.evolution.scalar,
      'child follows its parent (right), not its own left-leaning X');
  });

  it('preserves labels (de-collision is the render step\'s job, not this one)', async () => {
    const strategy = new WardleyMapValueChainOrganizedYPositionDefaultStrategy();
    const map = WardleyMapSchema.parse((await strategy.evaluate(chain, ctx)).result);
    assert.deepEqual(byId(map).get('user')!.label.position, { dx: -100, dy: 0 });
  });

  it('is idempotent — re-running reproduces the same layout', async () => {
    const strategy = new WardleyMapValueChainOrganizedYPositionDefaultStrategy();
    const once = WardleyMapSchema.parse((await strategy.evaluate(chain, ctx)).result);
    const twice = WardleyMapSchema.parse((await strategy.evaluate(once, ctx)).result);
    for (const c of once.components) {
      const t = byId(twice).get(c.id)!;
      assert.equal(t.position.visibility.scalar, c.position.visibility.scalar);
      assert.equal(t.position.evolution.scalar, c.position.evolution.scalar);
    }
  });

  it('preserves the upstream view config (input shape) untouched', async () => {
    const withView = WardleyMapSchema.parse({ ...chain }) as Record<string, unknown>;
    withView.renderConfig = { display: { axisEvolution: false, phases: false } };
    const { result } = await new WardleyMapValueChainOrganizedYPositionDefaultStrategy().evaluate(withView, ctx);
    const rc = (result as { renderConfig?: { display?: { axisEvolution?: boolean } } }).renderConfig;
    assert.deepEqual(rc, { display: { axisEvolution: false, phases: false } });
  });

  it('layers an anchorless map without crashing (longest-path roots at sources)', async () => {
    const anchorless = WardleyMapSchema.parse({
      title: 'x',
      components: [
        { id: 'a', label: { name: 'A' }, type: 'component',
          position: { evolution: { scalar: 0.4 }, visibility: { scalar: 0.3 } } },
      ],
      relations: [],
    });
    const strategy = new WardleyMapValueChainOrganizedYPositionDefaultStrategy();
    const y = WardleyMapSchema.parse((await strategy.evaluate(anchorless, ctx)).result)
      .components[0].position.visibility.scalar;
    assert.ok(y >= 0.05 && y <= 0.95);
  });
});
