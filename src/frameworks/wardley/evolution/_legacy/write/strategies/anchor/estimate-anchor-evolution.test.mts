// Would have caught: a failed or empty model call answered phase 2 at
// confidence 0.2, a guess passed off as an estimate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '#lib/prompts/init.mjs';
import { estimateAnchorEvolution } from './estimate-anchor-evolution.mjs';

const ANCHOR = { name: 'Envie de légumes frais (fictif)', context: 'Quartier (fictif)' };

describe('estimateAnchorEvolution', () => {
  it('throws when the model call fails or answers nothing, instead of phase 2', async () => {
    await assert.rejects(estimateAnchorEvolution(ANCHOR, async () => { throw new Error('provider down'); }), /provider down/);
    await assert.rejects(estimateAnchorEvolution(ANCHOR, async () => ''), /empty LLM response/);
  });

  it('places the anchor from the phase the model answers', async () => {
    const out = await estimateAnchorEvolution(ANCHOR, async () => 'phase=3\njustification=fictive\nconfidence=0.7');
    assert.equal(out.evolution, 0.55);
  });
});
