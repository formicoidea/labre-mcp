// Targeted tests for the degradation behavior of CpcEvolutionStrategy.
//
// Verifies the post-migration contract:
//   1. When the ambient collector is missing BigQuery env, a pre-flight
//      event is recorded under source 'bigquery'.
//   2. When fetchByCpc throws, the failure surfaces as a 'bigquery' event
//      and the strategy still returns a valid neutral result.
//   3. Outside an MCP invocation (no ambient collector), the strategy
//      degrades silently — preserving the original behavior for unit
//      tests and CLI scripts.
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
} from '../../../lib/degradation/index.mjs';

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

    // Inject a patentSource that returns empty data so the rest of the
    // pipeline runs without touching real BigQuery.
    const strategy = new CpcEvolutionStrategy({
      patentSource: { fetchByCpc: async () => ({ totalPatents: 0, patents: [] }) },
    });

    const collector = new DegradationCollector('test');
    const result = await withCollector(collector, () => strategy.evaluate(COMPONENT));

    assert.ok(result, 'strategy must still return a valid result');
    assert.equal(typeof result.evolution, 'number');
    assert.ok(collector.hasDegraded(), 'collector must report degraded');

    const bqEvents = collector.getEvents().filter((e) => e.source === 'bigquery');
    assert.equal(bqEvents.length, 1);
    assert.match(bqEvents[0].reason, /BigQuery not configured/);
  });

  it('records a bigquery event when fetchByCpc throws', async () => {
    registerHealthCheck('bigquery', async () => ({ ready: true }));

    const strategy = new CpcEvolutionStrategy({
      patentSource: {
        fetchByCpc: async () => { throw new Error('connection refused'); },
      },
      // Provide CPC codes so we get past _resolveCpcCodes without an LLM.
      cpcMapper: { mapToCpc: async () => ({ codes: ['G06F'], titles: {} }) },
    });

    const collector = new DegradationCollector('test');
    const result = await withCollector(collector, () => strategy.evaluate(COMPONENT));

    assert.ok(result);
    assert.equal(typeof result.evolution, 'number');
    assert.ok(collector.hasDegraded());

    const bqEvents = collector.getEvents().filter((e) => e.source === 'bigquery');
    assert.equal(bqEvents.length, 1);
    assert.match(bqEvents[0].reason, /connection refused/);
  });

  it('records a cpc-mapper event when the injected mapper throws', async () => {
    registerHealthCheck('bigquery', async () => ({ ready: true }));

    const strategy = new CpcEvolutionStrategy({
      cpcMapper: { mapToCpc: async () => { throw new Error('mapper boom'); } },
      patentSource: { fetchByCpc: async () => ({ totalPatents: 0, patents: [] }) },
    });

    const collector = new DegradationCollector('test');
    const result = await withCollector(collector, () => strategy.evaluate(COMPONENT));

    assert.ok(result);
    assert.ok(collector.hasDegraded());
    const mapperEvents = collector.getEvents().filter((e) => e.source === 'cpc-mapper');
    assert.ok(mapperEvents.length >= 1);
    assert.match(mapperEvents[0].reason, /mapper boom/);
  });

  it('outside any MCP invocation (no ambient collector), strategy still works silently', async () => {
    // Note: no withCollector wrapping → ambient collector is undefined.
    const strategy = new CpcEvolutionStrategy({
      patentSource: {
        fetchByCpc: async () => { throw new Error('this would normally degrade'); },
      },
      cpcMapper: { mapToCpc: async () => ({ codes: ['G06F'], titles: {} }) },
    });

    const result = await strategy.evaluate(COMPONENT);
    assert.ok(result, 'strategy must return a result even with no collector');
    assert.equal(typeof result.evolution, 'number');
    assert.equal(typeof result.confidence, 'number');
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
