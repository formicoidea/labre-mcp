// Fake data only: fictitious cases, and a local OpenAI-compatible server that
// plays the model. No real provider is ever reached, no key is real.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import '#lib/prompts/init.mjs';
import { resetLLMConfigCache } from '#lib/llm/config.loader.mjs';
import { resetLLMRegistryCache } from '#lib/llm/registry.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { runBenchmarkScenario } from './run-benchmark-scenario.tool.mjs';

const context: RequestContext = {
  projectId: 'test',
  projectRoot: process.cwd(),
  sessionId: 's1',
  domain: 'wardley',
};

const CASE = {
  name: 'Arrosage des tomates du jardin partagé',
  context: 'Jardin partagé de quartier (cas fictif)',
  description: 'Un tour de rôle affiché sur la porte de la cabane.',
};

const GRID = [
  'Market', 'Knowledge management', 'Market perception', 'User perception', 'Industry perception', 'Value focus',
  'Understanding', 'Comparison', 'Failure/deficiency', 'Market action/engagement', 'Efficiency', 'Decision driver',
].map((p, i) => `${p}=${i < 6 ? 2 : 4}|fictitious reason`).join('\n');

// What the fake model answers next, and what it was asked.
let reply = '';
let seen: { model?: string; auth?: string } = {};
let server: http.Server;
const savedConfig = process.env.WARDLEY_LLM_CONFIG;
let dir = '';

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { model: (JSON.parse(body) as { model: string }).model, auth: req.headers.authorization };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  dir = mkdtempSync(path.join(os.tmpdir(), 'labre-bench-'));
  const config = path.join(dir, 'llm.config.json');
  writeFileSync(config, JSON.stringify({
    defaultProvider: 'fake',
    providers: { fake: { kind: 'http-api', baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'FAKE_BENCH_KEY' } },
    strategies: { 'llm-direct': { provider: 'fake', model: 'unused' } },
  }));
  process.env.FAKE_BENCH_KEY = 'not-a-real-key';
  process.env.WARDLEY_LLM_CONFIG = config;
});

beforeEach(() => {
  resetLLMConfigCache();
  resetLLMRegistryCache();
});

after(async () => {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env.WARDLEY_LLM_CONFIG;
  else process.env.WARDLEY_LLM_CONFIG = savedConfig;
  delete process.env.FAKE_BENCH_KEY;
  resetLLMConfigCache();
  resetLLMRegistryCache();
});

describe('runBenchmarkScenario', () => {
  it('runs llm-direct on the model the caller names and meters its usage', async () => {
    reply = 'Reasoning about a fictitious case.\nevolution=0.62\nconfidence=0.70';
    const out = await runBenchmarkScenario(
      { scenario: 'llm-direct', provider: 'fake', model: 'fake-model-a', component: CASE },
      context,
    );
    assert.equal(out.ok, true);
    assert.equal(out.evolution, 0.62);
    assert.equal(out.confidence, 0.7);
    assert.equal(seen.model, 'fake-model-a');
    assert.equal(seen.auth, 'Bearer not-a-real-key');
    assert.equal(out.usage.llmCalls, 1);
    assert.equal(out.usage.inputTokens, 120);
    assert.equal(out.usage.outputTokens, 30);
    assert.match(JSON.stringify(out.details?.reasoning), /evolution=0.62/);
  });

  it('runs property-assessment and returns the per-property phases', async () => {
    reply = GRID;
    const out = await runBenchmarkScenario(
      { scenario: 'property-assessment', provider: 'fake', model: 'fake-model-b', component: CASE },
      context,
    );
    assert.equal(out.ok, true);
    // Six rows at phase 2, six at phase 4: a back-filled grid (all phase 2)
    // would answer 0.29, so this value proves every line was parsed.
    assert.equal(out.details?.properties?.length, 12);
    assert.equal(out.evolution, 0.57);
    assert.ok(out.details?.trace?.length);
    assert.equal(seen.model, 'fake-model-b');
  });

  // The benchmark counts what a failing case spent: a strategy error must not
  // lose the usage collected before it.
  it('reports a strategy failure with the usage already spent', async () => {
    reply = 'I cannot place this component.';
    const out = await runBenchmarkScenario(
      { scenario: 'llm-direct', provider: 'fake', model: 'fake-model-a', component: CASE },
      context,
    );
    assert.equal(out.ok, false);
    assert.ok(out.error);
    assert.equal(out.evolution, undefined);
    assert.equal(out.usage.llmCalls, 1);
    assert.equal(out.usage.inputTokens, 120);
  });

  it('refuses a reference value, an unknown scenario and an unknown provider', async () => {
    const base = { scenario: 'llm-direct', provider: 'fake', model: 'm', component: CASE };
    await assert.rejects(runBenchmarkScenario({ ...base, component: { ...CASE, expected: 0.5 } }, context));
    await assert.rejects(runBenchmarkScenario({ ...base, scenario: 's-curve' }, context));
    await assert.rejects(runBenchmarkScenario({ ...base, provider: 'nope' }, context), /Unknown provider/);
  });
});
