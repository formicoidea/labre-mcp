// Tests for emit-owm.mts
//
// Validates the OWM DSL output format:
//   - title appears first
//   - style is emitted (default plain, override honoured)
//   - optional size is emitted only when supplied
//   - metadata comments for non-empty fields
//   - anchor uses the `anchor` keyword (not `component`)
//   - other components use `component` with [vis, evo] label [dx, dy]
//   - links are emitted as A->B without quotes/spaces
//   - evolution/visibility are rounded to 2 decimals

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateChainOwmSyntax } from './emit-owm.mjs';
import type { PositionedValueChain } from '../../../../../types/value-chain.mjs';

function sampleChain(): PositionedValueChain {
  return {
    metadata: {
      title: 'Value chain of an online payment provider',
      angle: 'strategic positioning',
      scope: 'online payment processing',
      objective: 'map the value chain',
      imperatives: ['focus on innovation', 'cost sensitive'],
      temporality: 'present',
      contextSummary: 'Online payment provider.',
    },
    components: [
      { name: 'Merchant',       type: 'anchor',    role: 'anchor', visibility: 0.95, evolution: 0.5, label: { dx: -85, dy: -20 } },
      { name: 'Accept Payment', type: 'component', role: 'need', visibility: 0.80, evolution: 0.60, label: { dx: -40, dy: 5 } },
      { name: 'Fraud',          type: 'component', role: 'capability', visibility: 0.60, evolution: 0.40, label: { dx: 10, dy: 25 } },
    ],
    links: [
      { from: 'Merchant',       to: 'Accept Payment' },
      { from: 'Accept Payment', to: 'Fraud' },
    ],
  };
}

describe('generateChainOwmSyntax', () => {
  const owm = generateChainOwmSyntax(sampleChain());
  const lines = owm.split('\n');

  it('emits title as the first line', () => {
    assert.equal(lines[0], 'title Value chain of an online payment provider');
  });

  it('emits style plain by default', () => {
    assert.ok(lines.some(l => l === 'style plain'));
  });

  it('honours a custom style option', () => {
    const out = generateChainOwmSyntax(sampleChain(), { style: 'colour' });
    assert.ok(out.includes('style colour'));
    assert.ok(!out.includes('style plain'));
  });

  it('emits size only when supplied', () => {
    assert.ok(!owm.includes('size '));
    const out = generateChainOwmSyntax(sampleChain(), { size: { width: 1200, height: 800 } });
    assert.ok(out.includes('size [1200, 800]'));
  });

  it('emits metadata comments for non-empty fields', () => {
    assert.ok(lines.some(l => l.startsWith('// angle: strategic positioning')));
    assert.ok(lines.some(l => l.startsWith('// scope: online payment processing')));
    assert.ok(lines.some(l => l.startsWith('// temporality: present')));
    assert.ok(lines.some(l => l.startsWith('// objective:')));
    assert.ok(lines.some(l => l.startsWith('// imperatives: focus on innovation; cost sensitive')));
    assert.ok(lines.some(l => l.startsWith('// context: Online payment provider.')));
  });

  it('uses the anchor keyword for the anchor component', () => {
    assert.ok(lines.some(l => l.startsWith('anchor Merchant ')),
      'anchor must use the `anchor` keyword');
    assert.ok(!lines.some(l => l.startsWith('component Merchant')),
      'anchor must NOT be emitted as `component`');
  });

  it('emits each non-anchor component with [vis, evo] and label [dx, dy]', () => {
    const accept = lines.find(l => l.includes('Accept Payment'))!;
    assert.ok(accept.startsWith('component '));
    assert.match(accept, /\[0\.8, 0\.6\]/);
    assert.match(accept, /label \[-40, 5\]/);
  });

  it('does NOT quote multi-word names', () => {
    assert.ok(owm.includes('anchor Merchant '));
    assert.ok(owm.includes('component Accept Payment '));
    assert.ok(!owm.includes('"Accept Payment"'),
      'multi-word names must not be wrapped in double quotes');
  });

  it('emits every dependency link as A->B (no spaces around the arrow)', () => {
    assert.ok(owm.includes('Merchant->Accept Payment'));
    assert.ok(owm.includes('Accept Payment->Fraud'));
  });

  it('skips imperatives line when the array is empty', () => {
    const chain = sampleChain();
    chain.metadata.imperatives = [];
    const out = generateChainOwmSyntax(chain);
    assert.ok(!out.includes('// imperatives:'),
      'imperatives comment should be omitted when empty');
  });
});
