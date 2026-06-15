import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WardleyMapValueChainSelectByTypeComponentStrategy } from './component.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx = {} as RequestContext;

const chain = WardleyMapSchema.parse({
  title: 'Tea shop',
  context: 'online tea shop',
  components: [
    { id: 'user', label: { name: 'User' }, type: 'anchor',
      position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.05 } } },
    { id: 'order', label: { name: 'Order' }, type: 'component', subtype: 'userNeed',
      position: { evolution: { scalar: 0.4 }, visibility: { scalar: 0.4 } } },
    { id: 'pay', label: { name: 'Pay' }, type: 'component', subtype: 'functional', nature: 'activity',
      description: 'process payments',
      position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.8 } } },
  ],
  relations: [
    { id: 'r1', consumer: 'user', supplier: 'order' },
    { id: 'r2', consumer: 'order', supplier: 'pay' },
  ],
});

describe('wardley:map:value-chain:select-by-type:component', () => {
  it("keeps only type:'component' nodes (anchor and others excluded)", async () => {
    const strategy = new WardleyMapValueChainSelectByTypeComponentStrategy();
    const out = await strategy.evaluate(chain, ctx);
    const names = out.result.map((c) => c.name).sort();
    assert.deepEqual(names, ['Order', 'Pay'], 'anchor User excluded; two component nodes kept');
  });

  it('projects label.name -> name and carries description/nature/map context', async () => {
    const strategy = new WardleyMapValueChainSelectByTypeComponentStrategy();
    const out = await strategy.evaluate(chain, ctx);
    const pay = out.result.find((c) => c.name === 'Pay')!;
    assert.equal(pay.kind, 'capability');
    assert.equal(pay.description, 'process payments');
    assert.equal(pay.nature, 'activity');
    assert.equal(pay.context, 'online tea shop', 'business context comes from the map');
  });

  it('reports the selection counts in signals', async () => {
    const strategy = new WardleyMapValueChainSelectByTypeComponentStrategy();
    const out = await strategy.evaluate(chain, ctx);
    assert.equal(out.signals.find((s) => s.name === 'totalComponents')?.value, 3);
    assert.equal(out.signals.find((s) => s.name === 'selectedCount')?.value, 2);
  });

  it('returns an empty array for a non-WardleyMap input (no throw)', async () => {
    const strategy = new WardleyMapValueChainSelectByTypeComponentStrategy();
    const out = await strategy.evaluate({ not: 'a map' }, ctx);
    assert.deepEqual(out.result, []);
  });
});
