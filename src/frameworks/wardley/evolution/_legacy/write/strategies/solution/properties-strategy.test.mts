// Guard tests for corrections ported from the wardley-evolution-benchmark.
// Would have caught: a property rated twice counted twice in the coverage, and
// an answer made mostly of the phase-2 back-fill returned as an estimate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '#lib/prompts/init.mjs';
import { PropertiesStrategy } from './properties-strategy.mjs';

const NAMES = [
  'Market', 'Knowledge management', 'Market perception', 'User perception', 'Industry perception', 'Value focus',
  'Understanding', 'Comparison', 'Failure/deficiency', 'Market action/engagement', 'Efficiency', 'Decision driver',
];
const grid = (rows: string[]) => new PropertiesStrategy({ llmCall: async () => rows.join('\n') });

describe('PropertiesStrategy (auto)', () => {
  it('counts a property rated twice once, the last rating winning', async () => {
    const rows = [...NAMES.map((n) => `${n}=3|fictitious`), 'Market=4|second thought'];
    const out = await grid(rows).evaluate({ name: 'Composteur Zorglub (fictif)' } as never);
    assert.equal(out.properties?.length, 12);
    assert.equal(out.properties?.find((p) => p.property === 'Market')?.phase, 4);
    const evaluated = (out.trace?.find((t) => (t as { step?: string }).step === 'evaluate-properties') as { evaluated: number }).evaluated;
    assert.equal(evaluated, 12);
  });

  it('refuses when more than half the grid is unrated', async () => {
    await assert.rejects(grid(NAMES.slice(0, 5).map((n) => `${n}=3|x`)).evaluate({ name: 'Composteur Zorglub (fictif)' } as never), /7 of 12 properties unrated/);
    const six = await grid(NAMES.slice(0, 6).map((n) => `${n}=3|x`)).evaluate({ name: 'Composteur Zorglub (fictif)' } as never);
    assert.equal(six.properties?.filter((p) => /^Not evaluated/.test(p.reason ?? '')).length, 6);
  });
});
