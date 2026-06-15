import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WardleyMapSchema, ComponentSchema } from './wardley-map.schema.mjs';
import { JsonLabreSchema } from './json-labre.schema.mjs';

// Canonical component shape (=== @formicoidea/wardley-map-renderer):
// name lives in label.name; position uses nested {scalar}.
const baseComponent = {
  id: 'c1',
  label: { name: 'Authentication' },
  type: 'component' as const,
  position: { evolution: { scalar: 0.4 }, visibility: { scalar: 0.7 } },
};

describe('WardleyMapSchema (re-exported from the renderer package)', () => {
  it('accepts a minimal map (title + components + relations required)', () => {
    const parsed = WardleyMapSchema.parse({
      title: 'CSRD reporting for mid-caps',
      components: [baseComponent],
      relations: [],
    });
    assert.equal(parsed.components[0].label.name, 'Authentication');
    assert.equal(parsed.components[0].position.evolution.scalar, 0.4);
  });

  it('accepts subtype / nature / evolvesTo and id-based relations', () => {
    const parsed = WardleyMapSchema.parse({
      title: 'T',
      components: [
        {
          ...baseComponent,
          subtype: 'functional',
          nature: 'activity',
          evolvesTo: [{ position: { evolution: { scalar: 0.8 }, visibility: { scalar: 0.7 } }, evolveType: 'natural' }],
        },
        { id: 'c2', label: { name: 'Other' }, type: 'component', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } } },
      ],
      relations: [{ id: 'r1', consumer: 'c1', supplier: 'c2' }],
    });
    assert.equal(parsed.relations[0].consumer, 'c1');
    assert.equal(parsed.components[0].evolvesTo?.[0].evolveType, 'natural');
  });

  it('rejects a component without an id', () => {
    const bad = { label: { name: 'X' }, type: 'component', position: { evolution: { scalar: 0.5 }, visibility: { scalar: 0.5 } } };
    assert.equal(ComponentSchema.safeParse(bad).success, false);
  });

  it('rejects an evolution scalar out of [0,1]', () => {
    const bad = { ...baseComponent, position: { evolution: { scalar: 1.4 }, visibility: { scalar: 0.5 } } };
    assert.equal(ComponentSchema.safeParse(bad).success, false);
  });
});

describe('JsonLabreSchema', () => {
  it('wraps a wardley.map with the mandatory envelope structure', () => {
    const parsed = JsonLabreSchema.parse({
      wardley: { map: { title: 'T', components: [baseComponent], relations: [] } },
      envelope: { context: {}, signals: [], reasoning: [], insights: [], trace: [], references: [] },
    });
    assert.equal(parsed.version, '0.1.0'); // default applied
    assert.equal(parsed.wardley.map?.title, 'T');
  });

  it('accepts an empty wardley sub-tree (no command ran yet)', () => {
    const parsed = JsonLabreSchema.parse({
      envelope: { context: {}, signals: [], reasoning: [], insights: [], trace: [], references: [] },
    });
    assert.equal(parsed.wardley.map, undefined);
  });
});
