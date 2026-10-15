// Fake data only: a fictitious component and a stub model.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '#lib/prompts/init.mjs';
import { CertitudeUbiquityStrategy } from './certitude-ubiquity-strategy.mjs';
import { SCurveStrategy } from './s-curve-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const context = { projectId: 't', projectRoot: '.', sessionId: 's', domain: 'wardley' } as RequestContext;
const CASE = { kind: 'capability' as const, name: 'Arrosage des tomates (fictif)', context: 'Jardin partagé (fictif)' };
const SEVEN = 'certitude=0.80\nubiquity=0.90\nevolution=0.20\npub_wonder=0.1\npub_build=0.2\npub_operate=0.3\npub_usage=0.4';

describe('CertitudeUbiquityStrategy', () => {
  it('places the component with the S-curve from the two measures only, keeping the model\'s own answers aside', async () => {
    let asked = '';
    const out = await new CertitudeUbiquityStrategy({ llmCall: async (user) => { asked = user; return SEVEN; } }).evaluate(CASE, context);
    const projected = await new SCurveStrategy().evaluate({ ...CASE, certitude: 0.8, ubiquity: 0.9 }, context);
    assert.equal(out.result.evolution, projected.result.evolution);
    assert.notEqual(out.result.evolution, 0.2);
    assert.match(asked, /Component: Arrosage des tomates \(fictif\)\nContext: Jardin partagé \(fictif\)/);
    assert.equal(out.signals.find((s) => s.name === 'llm_evolution')?.value, 0.2);
    assert.equal(out.result.method, CertitudeUbiquityStrategy.method);
  });

  it('throws when a measure is missing or outside [0, 1]', async () => {
    const run = (reply: string) => new CertitudeUbiquityStrategy({ llmCall: async () => reply }).evaluate(CASE, context);
    await assert.rejects(run('ubiquity=0.5'), /"certitude=" missing/);
    await assert.rejects(run('certitude=1.4\nubiquity=0.5'), /outside \[0, 1\]/);
  });
});
