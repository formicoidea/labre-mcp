// Targeted tests for the degradation behavior of CpcEvolutionStrategy.
//
// Verifies the contract (refusal over default — a guess must never pass as
// an answer):
//   1. When the ambient collector is missing BigQuery env, a pre-flight
//      event is recorded under source 'bigquery' (informational, kept).
//   2. When fetchByCpc throws, the strategy rejects with that error instead
//      of answering a neutral position from empty patent data.
//   3. When the injected mapper throws, the strategy rejects instead of
//      falling back to the default mapper / empty CPC codes.
//   4. Zero patents or no CPC code rejects, with or without a collector.
//
// Guard: tests 2–4 used to assert a valid neutral result; they would catch a
// tryDegradeAmbient stand-in coming back on a path that feeds the position.
//
// No LLM, no real BigQuery, no network.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CpcEvolutionStrategy } from './cpc-evolution-strategy.mjs';
import {
  DegradationCollector,
  registerHealthCheck,
  clearRegistry,
  withCollector,
} from '#lib/degradation/index.mjs';

function silenceStdout(): () => void {
  const original = process.stdout.write.bind(process.stdout);
  // any: monkey-patching stdout for test isolation — see other degradation tests
  (process.stdout as any).write = (chunk: any, ..._args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('"notifications/')) return true;
    return original(chunk, ..._args);
  };
  return () => { (process.stdout as any).write = original; };
}

const COMPONENT = { name: 'TestCap', capability: 'test capability' };

/** Patent data with enough content for the indicators to score it. */
const SOME_PATENTS = {
  totalPatents: 50,
  patents: [],
  cpcDistribution: [{ cpc: 'G06F', count: 50 }],
  yearlyClassifications: [{ year: 2021, cpcCodes: ['G06F'] }],
  citationData: { totalForwardCitations: 200, patentCount: 50 },
  claimsTimeline: [{ year: 2021, avgIndependentClaims: 6 }],
  assigneeData: { uniqueAssignees: 20, totalPatents: 50 },
  geoData: { jurisdictionCount: 3 },
  sectorData: { uniqueSections: 2, uniqueClasses: 4 },
  expirationData: { expiredCount: 5, totalPatents: 50 },
};

describe('CpcEvolutionStrategy — degradation framework integration', () => {
  let restore: () => void;

  beforeEach(() => {
    clearRegistry();
    restore = silenceStdout();
  });

  afterEach(() => {
    restore();
    clearRegistry();
  });

  it('records a bigquery pre-flight event when env is not ready', async () => {
    registerHealthCheck('bigquery', async () => ({
      ready: false,
      reason: 'BigQuery not configured (missing: BIGQUERY_PROJECT_ID)',
      detail: { missing: ['BIGQUERY_PROJECT_ID'] },
    }));

    // Inject a mapper and a patentSource with data so the rest of the
    // pipeline runs without touching a real LLM or BigQuery.
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ({ codes: ['G06F'], titles: {} }) },
      patentSource: { fetchByCpc: async () => SOME_PATENTS },
    });

    const collector = new DegradationCollector('test');
    const result = await withCollector(collector, () => strategy.evaluate(COMPONENT));

    assert.ok(result, 'the pre-flight event is informational: data still answers');
    assert.equal(typeof result.evolution, 'number');
    assert.ok(collector.hasDegraded(), 'collector must report degraded');

    const bqEvents = collector.getEvents().filter((e) => e.source === 'bigquery');
    assert.equal(bqEvents.length, 1);
    assert.match(bqEvents[0].reason, /BigQuery not configured/);
  });

  it('rejects with the source error when fetchByCpc throws (no empty-data stand-in)', async () => {
    registerHealthCheck('bigquery', async () => ({ ready: true }));

    const strategy = new CpcEvolutionStrategy({
      patentSource: {
        fetchByCpc: async () => { throw new Error('connection refused'); },
      },
      // Provide CPC codes so we get past _resolveCpcCodes without an LLM.
      cpcMapper: { mapToCpc: async () => ({ codes: ['G06F'], titles: {} }) },
    });

    const collector = new DegradationCollector('test');
    await assert.rejects(
      withCollector(collector, () => strategy.evaluate(COMPONENT)),
      /connection refused/,
    );
    // The failure is the error itself, not a 'bigquery' degradation event
    // sitting next to a neutral position.
    assert.equal(collector.getEvents().filter((e) => e.source === 'bigquery').length, 0);
  });

  it('rejects with the mapper error when the injected mapper throws (no fallback mapper)', async () => {
    registerHealthCheck('bigquery', async () => ({ ready: true }));

    let fetched = false;
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('mapper boom'); } },
      patentSource: { fetchByCpc: async () => { fetched = true; return SOME_PATENTS; } },
    });

    const collector = new DegradationCollector('test');
    await assert.rejects(
      withCollector(collector, () => strategy.evaluate(COMPONENT)),
      /mapper boom/,
    );
    assert.equal(fetched, false, 'no patent query without CPC codes');
  });

  it('rejects when the mapper resolves no CPC code', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ({ codes: [], titles: {} }) },
      patentSource: { fetchByCpc: async () => SOME_PATENTS },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /no CPC code could be resolved for "test capability"/);
  });

  it('rejects when zero patents come back', async () => {
    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => ({ codes: ['G06F'], titles: {} }) },
      patentSource: { fetchByCpc: async () => ({ totalPatents: 0, patents: [] }) },
    });
    await assert.rejects(strategy.evaluate(COMPONENT), /no patent found for CPC G06F/);
  });

  it('outside any MCP invocation (no ambient collector), a source failure still rejects', async () => {
    // Note: no withCollector wrapping → ambient collector is undefined.
    // tryDegradeAmbient used to swallow this silently and return empty data.
    const strategy = new CpcEvolutionStrategy({
      patentSource: {
        fetchByCpc: async () => { throw new Error('this would normally degrade'); },
      },
      cpcMapper: { mapToCpc: async () => ({ codes: ['G06F'], titles: {} }) },
    });

    await assert.rejects(strategy.evaluate(COMPONENT), /this would normally degrade/);
  });

  it('records bigquery success without flipping degraded when env is ready', async () => {
    registerHealthCheck('bigquery', async () => ({ ready: true }));

    const strategy = new CpcEvolutionStrategy({
      patentSource: { fetchByCpc: async () => ({ totalPatents: 50, patents: [] }) },
      cpcMapper: { mapToCpc: async () => ({ codes: ['G06F'], titles: {} }) },
    });

    const collector = new DegradationCollector('test');
    const result = await withCollector(collector, () => strategy.evaluate(COMPONENT));

    assert.ok(result);
    assert.equal(collector.hasDegraded(), false, 'no degradation expected on happy path');
    assert.equal(collector.getEvents().length, 0);
  });
});
