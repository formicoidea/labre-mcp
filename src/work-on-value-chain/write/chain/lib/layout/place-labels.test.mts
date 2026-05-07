// Tests for place-labels.mts (V2 rule).
//
// Validates:
//   - leaf component â†’ label below center
//   - component on the right edge (X >= 0.95) â†’ label on the LEFT
//   - component on the left edge (X <= 0.05) â†’ label on the RIGHT
//   - middle component with more right children â†’ label on the LEFT
//   - middle component with more left children â†’ label on the RIGHT
//   - tie â†’ label LEFT (deterministic default)
//   - assignment is deterministic and does not mutate the input

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  placeLabels,
  pickLabelOffset,
  LABEL_BELOW,
  LABEL_LEFT,
  LABEL_RIGHT,
} from './place-labels.mjs';
import type { PositionedComponent, PositionedValueChain } from '../../../../../types/value-chain.mjs';

function comp(
  name: string,
  visibility: number,
  evolution: number,
  role: 'anchor' | 'need' | 'capability' = 'capability',
): PositionedComponent {
  return {
    name,
    type: role === 'anchor' ? 'anchor' : 'component',
    role,
    
    visibility,
    evolution,
    label: { dx: 0, dy: 0 },
  };
}

function chain(components: PositionedComponent[], links: Array<{ from: string; to: string }>): PositionedValueChain {
  return {
    metadata: {
      title: 't', angle: '', scope: '', objective: '', imperatives: [],
      temporality: 'present', contextSummary: '',
    },
    components,
    links,
  };
}

describe('pickLabelOffset', () => {
  it('places a leaf label below center', () => {
    const c = comp('Leaf', 0.5, 0.5);
    const ch = chain([c], []);
    assert.deepEqual(pickLabelOffset(c, ch), LABEL_BELOW);
  });

  it('places a right-edge component label on the LEFT', () => {
    const right = comp('R', 0.5, 0.97);
    const child = comp('C', 0.3, 0.97);
    const ch = chain([right, child], [{ from: 'R', to: 'C' }]);
    assert.deepEqual(pickLabelOffset(right, ch), LABEL_LEFT);
  });

  it('places a left-edge component label on the RIGHT', () => {
    const left = comp('L', 0.5, 0.03);
    const child = comp('C', 0.3, 0.03);
    const ch = chain([left, child], [{ from: 'L', to: 'C' }]);
    assert.deepEqual(pickLabelOffset(left, ch), LABEL_RIGHT);
  });

  it('middle component with more right children â†’ label LEFT', () => {
    const mid = comp('M', 0.5, 0.5);
    const r1 = comp('R1', 0.3, 0.7);
    const r2 = comp('R2', 0.3, 0.85);
    const l1 = comp('L1', 0.3, 0.3);
    const ch = chain([mid, r1, r2, l1], [
      { from: 'M', to: 'R1' },
      { from: 'M', to: 'R2' },
      { from: 'M', to: 'L1' },
    ]);
    assert.deepEqual(pickLabelOffset(mid, ch), LABEL_LEFT);
  });

  it('middle component with more left children â†’ label RIGHT', () => {
    const mid = comp('M', 0.5, 0.5);
    const l1 = comp('L1', 0.3, 0.3);
    const l2 = comp('L2', 0.3, 0.15);
    const r1 = comp('R1', 0.3, 0.7);
    const ch = chain([mid, l1, l2, r1], [
      { from: 'M', to: 'L1' },
      { from: 'M', to: 'L2' },
      { from: 'M', to: 'R1' },
    ]);
    assert.deepEqual(pickLabelOffset(mid, ch), LABEL_RIGHT);
  });

  it('tie defaults to LEFT', () => {
    const mid = comp('M', 0.5, 0.5);
    const l1 = comp('L1', 0.3, 0.3);
    const r1 = comp('R1', 0.3, 0.7);
    const ch = chain([mid, l1, r1], [
      { from: 'M', to: 'L1' },
      { from: 'M', to: 'R1' },
    ]);
    assert.deepEqual(pickLabelOffset(mid, ch), LABEL_LEFT);
  });
});

describe('placeLabels', () => {
  it('assigns labels deterministically and does not mutate the input', () => {
    const components = [
      comp('A',    0.94, 0.5,  'anchor'),
      comp('Leaf', 0.05, 0.7),
      comp('Mid',  0.5,  0.5),
    ];
    const links = [{ from: 'A', to: 'Mid' }, { from: 'Mid', to: 'Leaf' }];
    const ch = chain(components, links);

    const a = placeLabels(ch);
    const b = placeLabels(ch);

    for (const ac of a.components) {
      const bc = b.components.find(c => c.name === ac.name)!;
      assert.deepEqual(ac.label, bc.label);
    }
    for (const c of ch.components) {
      assert.deepEqual(c.label, { dx: 0, dy: 0 });
    }
  });
});
