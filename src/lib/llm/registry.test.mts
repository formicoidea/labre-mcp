import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetLLMConfigCache } from './config.loader.mjs';
import { setPostHogFlags } from '#lib/flags/state.mjs';
import type { PostHogFlags } from '#lib/flags/posthog.mjs';
import { AI_CALL_EMITTED_EVENT, AI_CALL_SENTINEL_DISTINCT_ID } from './ai-call-sentinel.mjs';
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
    defaultProvider: 'claude',
    providers: {
      'claude': { kind: 'agent-sdk' },
      'opencode': { kind: 'http-api', baseUrl: 'https://example.com/v1', apiKeyEnv: 'FAKE_KEY' },
    },
    strategies: {
      'publication-analysis': { provider: 'claude', model: 'claude-sonnet-4-6' },
      'timeline-benchmark':   { provider: 'claude', model: 'claude-sonnet-4-6' },
      'llm-direct':           { provider: 'claude', model: 'claude-sonnet-4-6' },
      'cpc-evolution':        { provider: 'claude', model: 'claude-sonnet-4-6' },
      'cpc-mapper':           { provider: 'claude', model: 'claude-sonnet-4-6' },
      'logprob-distribution': { provider: 'opencode',   model: 'kimi-k2.5', topLogprobs: 5 },
      'properties-strategy':  { provider: 'claude', model: 'claude-sonnet-4-6' },
      'anchor-evolution':     { provider: 'claude', model: 'claude-sonnet-4-6' },
      'identify-capability':  { provider: 'claude', model: 'claude-sonnet-4-6' },
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
    cfg.strategies['logprob-distribution'] = { provider: 'claude', model: 'claude-sonnet-4-6' };
    writeConfig(cfg);
    assert.throws(
      () => getStrategyLogprobLLM('logprob-distribution'),
      /requires capability "logprobs" but provider "claude"/,
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

// ─── AiCallEmitted sentinel ──────────────────────────────────────────────────
//
// The invariant under test: every LLM call the registry hands out is counted,
// once per invocation. Calls are exercised against the `http-api` provider with
// an UNSET api-key env var: `createOpenCodeCall` throws on the missing key
// before any fetch, so these tests reach no provider and no network — they only
// observe what the sentinel emitted on the way in.

interface CapturedEvent {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}

/** Minimal PostHogFlags double: records captures, stubs the rest. */
function fakeFlags(captured: CapturedEvent[], captureImpl?: () => never): PostHogFlags {
  return {
    isRecipeEnabled: async () => true,
    resolveRecipeVariant: async () => undefined,
    resolvePromptVariants: async () => ({}),
    capture(event, distinctId, properties) {
      if (captureImpl) captureImpl();
      captured.push({ event, distinctId, properties });
    },
    shutdown: async () => {},
  };
}

/** Config whose text strategy resolves to http-api with a key env that is not
 *  set — invocation fails fast, locally, with no network call. */
function keylessHttpConfig() {
  return {
    defaultProvider: 'opencode',
    providers: {
      'opencode': {
        kind: 'http-api',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'LABRE_TEST_UNSET_API_KEY',
      },
    },
    strategies: {
      'sentinel-probe': { provider: 'opencode', model: 'kimi-k2.5' },
    },
  };
}

describe('registry — AiCallEmitted sentinel', () => {
  let captured: CapturedEvent[];

  beforeEach(() => {
    captured = [];
    delete process.env.LABRE_TEST_UNSET_API_KEY;
    setPostHogFlags(fakeFlags(captured));
  });

  afterEach(() => {
    setPostHogFlags(undefined);
  });

  it('emits nothing when the call is merely constructed', () => {
    writeConfig(keylessHttpConfig());
    getStrategyLLM('sentinel-probe');
    assert.equal(captured.length, 0);
  });

  it('emits one event per invocation with metadata-only props', async () => {
    writeConfig(keylessHttpConfig());
    const call = getStrategyLLM('sentinel-probe');

    await assert.rejects(() => call('hello'), /API key not configured/);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], {
      event: AI_CALL_EMITTED_EVENT,
      distinctId: AI_CALL_SENTINEL_DISTINCT_ID,
      properties: {
        source: 'mcp',
        strategy: 'sentinel-probe',
        provider: 'opencode',
        model: 'kimi-k2.5',
        capability: 'text',
      },
    });

    // The call itself is cached; the event is not — a second use counts again.
    await assert.rejects(() => call('hello again'), /API key not configured/);
    assert.equal(captured.length, 2);
  });

  it('reports the capability the call site asked for', async () => {
    writeConfig(keylessHttpConfig());
    const call = getStrategyLogprobLLM('sentinel-probe');
    await assert.rejects(() => call('hello'), /API key not configured/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].properties?.capability, 'logprobs');
  });

  it('never carries the prompt, the response or a key', async () => {
    writeConfig(keylessHttpConfig());
    const call = getStrategyLLM('sentinel-probe');
    await assert.rejects(() => call('a very secret prompt'), /API key not configured/);
    const serialized = JSON.stringify(captured);
    assert.ok(!serialized.includes('a very secret prompt'));
    assert.ok(!serialized.includes('LABRE_TEST_UNSET_API_KEY'));
  });

  it('survives a telemetry client that throws (call unaffected)', async () => {
    writeConfig(keylessHttpConfig());
    setPostHogFlags(
      fakeFlags(captured, () => {
        throw new Error('posthog exploded');
      }),
    );
    const call = getStrategyLLM('sentinel-probe');
    // The LLM error surfaces, not the telemetry one — and nothing is counted
    // (accepted under-count, documented in ai-call-sentinel.mts).
    await assert.rejects(() => call('hello'), /API key not configured/);
    assert.equal(captured.length, 0);
  });

  it('is inert when no PostHog is installed (stdio / local daemon)', async () => {
    writeConfig(keylessHttpConfig());
    setPostHogFlags(undefined);
    const call = getStrategyLLM('sentinel-probe');
    await assert.rejects(() => call('hello'), /API key not configured/);
    assert.equal(captured.length, 0);
  });

  it('does not count a test override', async () => {
    writeConfig(keylessHttpConfig());
    const stub = async () => 'stubbed';
    setLLMCallForTesting('sentinel-probe', 'text', stub);
    const call = getStrategyLLM('sentinel-probe');
    assert.equal(call, stub);
    assert.equal(await call(), 'stubbed');
    assert.equal(captured.length, 0);
  });
});
