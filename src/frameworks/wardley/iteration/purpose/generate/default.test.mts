import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Side-effect: registers the 'parsePurposeContext' parser consumed by evaluate()'s
// getPrompt().parse() path (mirrors how the daemon boot pulls in init.mjs).
import '#lib/prompts/init.mjs';
import {
  WardleyIterationPurposeGenerateDefaultStrategy,
  parsePurposeContextResponse,
} from './default.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const requestCtx: RequestContext = {
  projectId: 't', projectRoot: '/t', sessionId: 's', domain: 'wardley',
};

const FULL_CONTEXT = {
  raisonDetre: "Améliorer les conditions de travail en préservant l'Homme et son environnement",
  title: 'Réaligner la production neuve sur la circularité',
  scope: 'Modèle économique du télescopique ULM 412 H',
  angle: 'Impact écologique de la production neuve',
  temporality: 'present',
  granularity: 'un produit',
  deliverables: ['carte Wardley', 'reco stratégique'],
  problematisation: 'Quelle solution minimise l’impact écologique de la production neuve ?',
};

describe('parsePurposeContextResponse', () => {
  it('extracts JSON, validates, and drops unknown keys', () => {
    const raw = `Voici:\n${JSON.stringify({ ...FULL_CONTEXT, bogus: 'x' })}`;
    const ctx = parsePurposeContextResponse(raw);
    assert.equal(ctx.title, FULL_CONTEXT.title);
    assert.equal(ctx.raisonDetre, FULL_CONTEXT.raisonDetre);
    assert.deepEqual(ctx.deliverables, FULL_CONTEXT.deliverables);
    assert.ok(!('bogus' in ctx));
  });

  it('fills defaults for a partial LLM answer', () => {
    const ctx = parsePurposeContextResponse('{"title":"Objectif X"}');
    assert.equal(ctx.title, 'Objectif X');
    assert.equal(ctx.raisonDetre, '');
    assert.equal(ctx.temporality, 'present');
    assert.deepEqual(ctx.deliverables, []);
  });

  it('throws on a response with no JSON object', () => {
    assert.throws(() => parsePurposeContextResponse('no json here'));
  });
});

describe('strategy.evaluate', () => {
  it('generates a Context from an injected LLM', async () => {
    const stub = async () => JSON.stringify(FULL_CONTEXT);
    const strat = new WardleyIterationPurposeGenerateDefaultStrategy({ llmCall: stub });
    const res = await strat.evaluate({ topic: 'ULM 412 H', intent: 'décarboner' }, requestCtx);
    assert.equal(res.result.title, FULL_CONTEXT.title);
    assert.equal(res.result.problematisation, FULL_CONTEXT.problematisation);
    assert.equal(res.signals.find((s) => s.name === 'llm-used')?.value, true);
    assert.equal(res.signals.find((s) => s.name === 'topic')?.value, 'ULM 412 H');
  });

  it('stamps the ambient userPrompt (RequestContext) onto the result Context', async () => {
    const stub = async () => JSON.stringify(FULL_CONTEXT);
    const strat = new WardleyIterationPurposeGenerateDefaultStrategy({ llmCall: stub });
    const res = await strat.evaluate(
      { topic: 'ULM 412 H' },
      { ...requestCtx, userPrompt: 'décarbone la prod du ULM stp' },
    );
    assert.equal(res.result.prompt, 'décarbone la prod du ULM stp');
  });

  it('degrades to a skeleton Context (title = topic) when the LLM is unavailable', async () => {
    const strat = new WardleyIterationPurposeGenerateDefaultStrategy({
      llmCall: async () => { throw new Error('offline'); },
    });
    const res = await strat.evaluate({ topic: 'Épargne salariale' }, requestCtx);
    assert.equal(res.result.title, 'Épargne salariale');
    assert.equal(res.result.raisonDetre, ''); // audit will flag this
    assert.equal(res.signals.find((s) => s.name === 'llm-used')?.value, false);
    assert.ok(res.insights.some((i) => /LLM unavailable/.test(i.text)));
  });

  it('degrades to a skeleton Context when the LLM returns malformed JSON', async () => {
    const strat = new WardleyIterationPurposeGenerateDefaultStrategy({
      llmCall: async () => 'not json at all',
    });
    const res = await strat.evaluate({ topic: 'X' }, requestCtx);
    assert.equal(res.result.title, 'X');
    assert.equal(res.signals.find((s) => s.name === 'llm-used')?.value, false);
  });
});
