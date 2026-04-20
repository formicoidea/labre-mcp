import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetLLMConfigCache } from './config.loader.mjs';
import {
  getStrategyLLM,
  getStrategyLogprobLLM,
  resetLLMRegistryCache,
  setLLMCallForTesting,
} from './registry.mjs';

let dir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-registry-'));
  originalEnv = process.env.WARDLEY_LLM_CONFIG;
  resetLLMConfigCache();
  resetLLMRegistryCache();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.WARDLEY_LLM_CONFIG;
  else process.env.WARDLEY_LLM_CONFIG = originalEnv;
  rmSync(dir, { recursive: true, force: true });
  resetLLMConfigCache();
  resetLLMRegistryCache();
});

function writeConfig(content: unknown): void {
  const path = join(dir, 'llm.config.json');
  writeFileSync(path, JSON.stringify(content));
  process.env.WARDLEY_LLM_CONFIG = path;
}

function fullValidConfig() {
  return {
    defaultProvider: 'claude-sdk',
    providers: {
      'claude-sdk': { kind: 'agent-sdk' },
      'opencode': { kind: 'http-api', baseUrl: 'https://example.com/v1', apiKeyEnv: 'FAKE_KEY' },
    },
    strategies: {
      'publication-analysis': { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
      'timeline-benchmark':   { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
      'llm-direct':           { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
      'cpc-evolution':        { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
      'cpc-mapper':           { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
      'logprob-distribution': { provider: 'opencode',   model: 'kimi-k2.5', topLogprobs: 5 },
      'properties-strategy':  { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
      'anchor-evolution':     { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
      'identify-capability':  { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
    },
  };
}

describe('registry', () => {
  it('returns a callable LLM for a mapped text strategy', () => {
    writeConfig(fullValidConfig());
    const call = getStrategyLLM('publication-analysis');
    assert.equal(typeof call, 'function');
  });

  it('returns a callable logprob LLM for logprob-distribution', () => {
    writeConfig(fullValidConfig());
    const call = getStrategyLogprobLLM('logprob-distribution');
    assert.equal(typeof call, 'function');
  });

  it('caches calls across invocations (same reference)', () => {
    writeConfig(fullValidConfig());
    const a = getStrategyLLM('publication-analysis');
    const b = getStrategyLLM('publication-analysis');
    assert.equal(a, b);
  });

  it('rejects a config where logprob-distribution points to agent-sdk', () => {
    const cfg = fullValidConfig();
    cfg.strategies['logprob-distribution'] = { provider: 'claude-sdk', model: 'claude-sonnet-4-6' };
    writeConfig(cfg);
    assert.throws(
      () => getStrategyLogprobLLM('logprob-distribution'),
      /requires capability "logprobs" but provider "claude-sdk"/,
    );
  });

  it('falls back to defaultProvider when the strategy entry is missing', () => {
    const cfg = fullValidConfig();
    delete (cfg.strategies as Record<string, unknown>)['properties-strategy'];
    writeConfig(cfg);
    const call = getStrategyLLM('properties-strategy');
    assert.equal(typeof call, 'function');
  });

  it('honors test overrides via setLLMCallForTesting', () => {
    writeConfig(fullValidConfig());
    const stub = async () => 'stubbed';
    setLLMCallForTesting('publication-analysis', 'text', stub);
    const call = getStrategyLLM('publication-analysis');
    assert.equal(call, stub);
  });
});
