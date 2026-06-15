import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fromPositionedValueChain, toPositionedValueChain } from './value-chain.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import type { PositionedValueChain } from '#types/value-chain.mjs';

const chain: PositionedValueChain = {
  metadata: {
    title: 'Online payments',
    angle: 'operational',
    scope: 'the firm',
    objective: 'reduce fraud',
    imperatives: [],
    temporality: 'present',
    contextSummary: '',
  },
  components: [
    { name: 'Customer', type: 'anchor', role: 'anchor', visibility: 0.95, evolution: 0.5, label: { dx: 0, dy: 0 } },
    { name: 'Checkout', type: 'component', role: 'need', visibility: 0.8, evolution: 0.6, label: { dx: 1, dy: -1 } },
    { name: 'Auth', type: 'component', role: 'capability', nature: 'activity', description: 'login', visibility: 0.6, evolution: 0.4, label: { dx: 0, dy: 0 } },
  ],
  links: [
    { from: 'Customer', to: 'Checkout' },
    { from: 'Checkout', to: 'Auth' },
  ],
};

describe('ACL WardleyMap ↔ PositionedValueChain (renderer schema)', () => {
  it('projects to a schema-valid canonical map with id-based relations', () => {
    const map = fromPositionedValueChain(chain);
    WardleyMapSchema.parse(map); // already parsed inside; double-check it stays valid
    assert.equal(map.components[0].id, 'customer');
    assert.equal(map.components[0].label.name, 'Customer');
    assert.equal(map.components[0].position.evolution.scalar, 0.5);
    // Visibility is INVERTED at the ACL boundary: legacy 0.95 (anchor/top) →
    // renderer scalar 0.05 (top, since visToY = plotTop + scalar*plotHeight).
    assert.equal(map.components[0].position.visibility.scalar, 0.05);
    // A deep capability (legacy 0.6) lands lower on the canvas (scalar 0.4).
    assert.equal(map.components[2].position.visibility.scalar, 0.4);
    assert.equal(map.relations[0].consumer, 'customer');
    assert.equal(map.relations[0].supplier, 'checkout');
    assert.ok(map.relations[0].id);
    // need → userNeed subtype ; capability → functional subtype
    assert.equal(map.components[1].subtype, 'userNeed');
    assert.equal(map.components[2].subtype, 'functional');
  });

  it('round-trips components + links (metadata angle/scope are lossy via context string)', () => {
    const restored = toPositionedValueChain(fromPositionedValueChain(chain));
    assert.deepEqual(restored.components, chain.components);
    assert.deepEqual(restored.links, chain.links);
    assert.equal(restored.metadata.title, chain.metadata.title);
  });
});
