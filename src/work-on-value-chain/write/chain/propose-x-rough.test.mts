// Tests for propose-x-rough.mts
//
// Validates:
//   - parser accepts the canonical { positions: [{ name, xHint }] } JSON
//   - parser tolerates surrounding prose (extracts the JSON payload)
//   - duplicate names → first wins, no throw
//   - out-of-range xHint → Zod throws
//   - proposeXRough() merges hints onto the input chain by component name
//   - components missing from the LLM response keep xHint === undefined
//   - LLM degradation (null response) returns the input unchanged

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../../../lib/prompts/init.mjs';
import {
  parseProposeXRoughResponse,
  proposeXRough,
} from './propose-x-rough.mjs';
import type { RawValueChain } from '../../../types/value-chain.mjs';

function makeRaw(): RawValueChain {
  return {
    metadata: {
      title: 'Stripe value chain',
      angle: 'merchant view',
      scope: 'online payments',
      objective: 'map',
      imperatives: [],
      temporality: 'present',
      contextSummary: '',
    },
    components: [
      { name: 'Merchant',       type: 'anchor',    role: 'anchor',     phase: 'phase4' },
      { name: 'Accept Payment', type: 'component', role: 'need',       phase: 'phase3' },
      { name: 'Fraud Check',    type: 'component', role: 'capability', phase: 'phase2' },
    ],
    links: [
      { from: 'Merchant',       to: 'Accept Payment' },
      { from: 'Accept Payment', to: 'Fraud Check' },
    ],
  };
}

describe('parseProposeXRoughResponse', () => {
  it('parses the canonical positions JSON', () => {
    const out = parseProposeXRoughResponse(JSON.stringify({
      positions: [
        { name: 'Merchant',       xHint: 0.45 },
        { name: 'Accept Payment', xHint: 0.60 },
      ],
    }));
    assert.equal(out.size, 2);
    assert.equal(out.get('Merchant'), 0.45);
    assert.equal(out.get('Accept Payment'), 0.60);
  });

  it('tolerates surrounding prose', () => {
    const out = parseProposeXRoughResponse(
      'Here is the layout:\n```json\n' +
      JSON.stringify({ positions: [{ name: 'A', xHint: 0.30 }] }) +
      '\n```',
    );
    assert.equal(out.get('A'), 0.30);
  });

  it('drops duplicates (first wins) without throwing', () => {
    const out = parseProposeXRoughResponse(JSON.stringify({
      positions: [
        { name: 'A', xHint: 0.30 },
        { name: 'A', xHint: 0.90 },
      ],
    }));
    assert.equal(out.size, 1);
    assert.equal(out.get('A'), 0.30);
  });

  it('rejects xHint > 1', () => {
    assert.throws(() => parseProposeXRoughResponse(JSON.stringify({
      positions: [{ name: 'A', xHint: 1.5 }],
    })));
  });

  it('rejects xHint < 0', () => {
    assert.throws(() => parseProposeXRoughResponse(JSON.stringify({
      positions: [{ name: 'A', xHint: -0.1 }],
    })));
  });

  it('throws when no JSON object is present', () => {
    assert.throws(() => parseProposeXRoughResponse('no payload here'));
  });
});

describe('proposeXRough()', () => {
  // any: minimal mock of the provider llmCall signature
  function makeMock(response: string | null) {
    return async (_user: string, _unused: any, _opts: any) => response as any;
  }

  it('merges hints onto matching components by name', async () => {
    const out = await proposeXRough(
      makeRaw(),
      makeMock(JSON.stringify({
        positions: [
          { name: 'Merchant',       xHint: 0.50 },
          { name: 'Accept Payment', xHint: 0.60 },
          { name: 'Fraud Check',    xHint: 0.30 },
        ],
      })),
    );
    const byName = new Map(out.components.map(c => [c.name, c.xHint]));
    assert.equal(byName.get('Merchant'),       0.50);
    assert.equal(byName.get('Accept Payment'), 0.60);
    assert.equal(byName.get('Fraud Check'),    0.30);
  });

  it('leaves xHint undefined for components missing in the response', async () => {
    const out = await proposeXRough(
      makeRaw(),
      makeMock(JSON.stringify({
        positions: [{ name: 'Merchant', xHint: 0.50 }],
      })),
    );
    const byName = new Map(out.components.map(c => [c.name, c.xHint]));
    assert.equal(byName.get('Merchant'),       0.50);
    assert.equal(byName.get('Accept Payment'), undefined);
    assert.equal(byName.get('Fraud Check'),    undefined);
  });

  it('returns the input chain unchanged when the LLM degrades to null', async () => {
    const raw = makeRaw();
    const out = await proposeXRough(raw, makeMock(null));
    // Reference equality on metadata + same component count + xHints unset.
    assert.equal(out.components.length, raw.components.length);
    for (const c of out.components) {
      assert.equal(c.xHint, undefined);
    }
  });

  it('preserves metadata and links untouched', async () => {
    const raw = makeRaw();
    const out = await proposeXRough(
      raw,
      makeMock(JSON.stringify({
        positions: [{ name: 'Merchant', xHint: 0.50 }],
      })),
    );
    assert.deepEqual(out.metadata, raw.metadata);
    assert.deepEqual(out.links, raw.links);
  });
});
