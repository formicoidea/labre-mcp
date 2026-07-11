import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Side-effect: registers the 'parsePurposeAudit' parser consumed by evaluate()'s
// getPrompt().parse() path (mirrors how the daemon boot pulls in init.mjs).
import '#lib/prompts/init.mjs';
import {
  WardleyIterationPurposeAuditPurposeQualityDefaultStrategy,
  deterministicChecks,
  mergeVerdicts,
  parsePurposeAuditResponse,
  PURPOSE_AUDIT_DIMENSIONS,
} from './default.mjs';
import { PurposeContextSchema } from '#schemas/context.schema.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx = (o: Record<string, unknown>) => PurposeContextSchema.parse(o);

const requestCtx: RequestContext = {
  projectId: 't', projectRoot: '/t', sessionId: 's', domain: 'wardley',
};

// A well-formed purpose (all fields present, problématisation ends with '?').
const GOOD = {
  title: 'Réaligner la production neuve sur la circularité',
  scope: 'Modèle économique du télescopique ULM 412 H',
  angle: 'Impact écologique de la production neuve',
  temporality: 'present',
  granularity: 'un produit',
  deliverables: ['carte Wardley', 'reco stratégique'],
  raisonDetre: 'Améliorer les conditions de travail tout en préservant l’Homme et son environnement',
  problematisation: 'Quelle solution minimise l’impact écologique de la production neuve du ULM 412 H ?',
};

describe('deterministicChecks', () => {
  it('flags a missing raison d\'être as a fail on anchor + coherence', () => {
    const out = deterministicChecks(ctx({ ...GOOD, raisonDetre: '' }));
    assert.equal(out['anchor-raison-detre']?.verdict, 'fail');
    assert.equal(out['objective-coherence']?.verdict, 'fail');
  });

  it('fails problematisation when absent, warns when not a question', () => {
    assert.equal(deterministicChecks(ctx({ ...GOOD, problematisation: '' }))['problematisation']?.verdict, 'fail');
    assert.equal(
      deterministicChecks(ctx({ ...GOOD, problematisation: 'On étudie le modèle.' }))['problematisation']?.verdict,
      'warn',
    );
  });

  it('fails context-legitimation only when scope, angle AND granularity are all empty', () => {
    assert.equal(
      deterministicChecks(ctx({ ...GOOD, scope: '', angle: '', granularity: '' }))['context-legitimation']?.verdict,
      'fail',
    );
    assert.equal(deterministicChecks(ctx({ ...GOOD, angle: '', granularity: '' }))['context-legitimation'], undefined);
  });

  it('warns on an over-long objective, stays silent on a concise one', () => {
    assert.equal(deterministicChecks(ctx({ ...GOOD, title: 'x'.repeat(200) }))['concision-tangibility']?.verdict, 'warn');
    assert.equal(deterministicChecks(ctx(GOOD))['concision-tangibility'], undefined);
  });
});

describe('mergeVerdicts', () => {
  it('deterministic fail wins over an LLM pass (a missing field cannot be rescued)', () => {
    const det = deterministicChecks(ctx({ ...GOOD, raisonDetre: '' }));
    const llm = { 'anchor-raison-detre': { verdict: 'pass' as const, rationale: 'looks fine' } };
    const merged = mergeVerdicts(det, llm);
    assert.equal(merged.find((d) => d.id === 'anchor-raison-detre')?.verdict, 'fail');
  });

  it('prefers the LLM verdict where no deterministic verdict exists', () => {
    const merged = mergeVerdicts({}, { 'right-granularity': { verdict: 'warn', rationale: 'trop large' } });
    assert.equal(merged.find((d) => d.id === 'right-granularity')?.verdict, 'warn');
  });

  it('marks unassessed dimensions as warn (never a silent pass) and notes degradation when llm is null', () => {
    const merged = mergeVerdicts({}, null);
    assert.equal(merged.length, PURPOSE_AUDIT_DIMENSIONS.length);
    assert.ok(merged.every((d) => d.verdict === 'warn'));
    assert.ok(merged.every((d) => /dégradé/.test(d.rationale)));
  });
});

describe('parsePurposeAuditResponse', () => {
  it('extracts JSON, keeps known ids, drops unknown ones', () => {
    const raw = 'Sure!\n{"dimensions":[{"id":"problematisation","verdict":"pass","rationale":"ok"},{"id":"bogus","verdict":"fail","rationale":"x"}]}';
    const out = parsePurposeAuditResponse(raw);
    assert.equal(out['problematisation']?.verdict, 'pass');
    assert.equal(Object.keys(out).length, 1);
  });

  it('throws on a response with no JSON object', () => {
    assert.throws(() => parsePurposeAuditResponse('no json here'));
  });
});

describe('strategy.evaluate', () => {
  it('degrades to deterministic-only when no LLM is injected/available', async () => {
    // Injecting a null-returning llmCall keeps it fully offline (no registry hit).
    const strat = new WardleyIterationPurposeAuditPurposeQualityDefaultStrategy({
      llmCall: async () => { throw new Error('offline'); },
    });
    const res = await strat.evaluate({ ...GOOD, raisonDetre: '' }, requestCtx);
    // One insight per dimension, output mirrored into result.
    assert.equal(res.insights.length, PURPOSE_AUDIT_DIMENSIONS.length);
    assert.deepEqual(res.result, res.insights);
    // The missing raison d'être surfaces as a FAIL insight even offline.
    assert.ok(res.insights.some((i) => /FAIL · Ancrage raison d'être/.test(i.text)));
    assert.equal(res.signals.find((s) => s.name === 'llm-used')?.value, false);
  });

  it('uses an injected LLM and merges its verdicts', async () => {
    const stub = async () =>
      JSON.stringify({
        dimensions: PURPOSE_AUDIT_DIMENSIONS.map((d) => ({ id: d.id, verdict: 'pass', rationale: 'ok' })),
      });
    const strat = new WardleyIterationPurposeAuditPurposeQualityDefaultStrategy({ llmCall: stub });
    const res = await strat.evaluate(GOOD, requestCtx);
    assert.equal(res.signals.find((s) => s.name === 'llm-used')?.value, true);
    assert.ok(res.insights.every((i) => /PASS ·/.test(i.text)));
  });
});
