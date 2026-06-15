import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OverlapCheckStrategy } from './overlap-check-strategy.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx = {} as RequestContext;

const map = WardleyMapSchema.parse({
  title: 'Tea shop',
  components: [
    { id: 'user', label: { name: 'User', position: { dx: 0, dy: 25 } }, type: 'anchor',
      position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.05 } } },
    { id: 'order', label: { name: 'Order', position: { dx: 0, dy: 25 } }, type: 'component', subtype: 'userNeed',
      position: { evolution: { scalar: 0.55 }, visibility: { scalar: 0.4 } } },
    { id: 'pay', label: { name: 'Pay', position: { dx: 0, dy: 25 } }, type: 'component', subtype: 'functional',
      position: { evolution: { scalar: 0.6 }, visibility: { scalar: 0.8 } } },
  ],
  relations: [
    { id: 'r1', consumer: 'user', supplier: 'order' },
    { id: 'r2', consumer: 'order', supplier: 'pay' },
  ],
});

describe('wardley:map:value-chain:audit:overlap-check', () => {
  it('audits a canonical WardleyMap and reports residual overlap counts', async () => {
    const { result, signals } = await new OverlapCheckStrategy().evaluate(map, ctx);
    assert.ok(result, 'returns a result');
    // The verified map is itself canonical (re-projected through the ACL).
    assert.equal(WardleyMapSchema.parse(result!.map).components.length, 3);
    assert.equal(typeof result!.unresolvedHard, 'number');
    assert.ok(signals.some((s) => s.name === 'iterations'));
  });

  it('returns null on a non-canonical input (listener stays harmless)', async () => {
    const { result } = await new OverlapCheckStrategy().evaluate(null, ctx);
    assert.equal(result, null);
  });
});
