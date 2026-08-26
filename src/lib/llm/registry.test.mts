import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLLMConfig, resetLLMConfigCache } from './config.loader.mjs';
import { setPostHogFlags } from '#lib/flags/state.mjs';
import type { PostHogFlags } from '#lib/flags/posthog.mjs';
import { AI_CALL_EMITTED_EVENT, AI_CALL_SENTINEL_DISTINCT_ID } from './ai-call-sentinel.mjs';
import {
  getStrategyLLM,
  getStrategyLogprobLLM,
  getStrategyVisionLLM,
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
    defaultModel: 'claude-sonnet-4-6',
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

// ─── Explicit fallback route ─────────────────────────────────────────────────
//
// The fallback used to take "the model of the FIRST strategy declared for the
// default provider", so reordering llm.config.json changed which model ran.
// It now reads `defaultModel`, or fails saying so.

/** Captures console.warn for the duration of `fn`. */
async function withCapturedWarnings(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

/**
 * Config whose DEFAULT route is the keyless http-api provider: resolving is
 * free, and invoking throws locally on the missing key before any network call
 * (same trick as the sentinel suite below). Nothing here can reach a model.
 * `strategies` deliberately declares several entries on that same default
 * provider, each with a DIFFERENT model — that is exactly the shape the old
 * order-dependent lookup got wrong.
 */
function fallbackConfig(firstStrategyModel = 'model-of-the-first-entry') {
  return {
    defaultProvider: 'opencode',
    defaultModel: 'the-declared-default-model',
    providers: {
      'opencode': {
        kind: 'http-api',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'LABRE_TEST_UNSET_API_KEY',
      },
    },
    strategies: {
      'first-entry':  { provider: 'opencode', model: firstStrategyModel },
      'second-entry': { provider: 'opencode', model: 'model-of-the-second-entry' },
    },
  };
}

describe('registry — fallback route', () => {
  beforeEach(() => {
    delete process.env.LABRE_TEST_UNSET_API_KEY;
  });

  afterEach(() => {
    setPostHogFlags(undefined);
  });

  /** Resolve an unmapped id and report the model the sentinel saw — the
   *  observable proof of which route was taken, without touching a provider. */
  async function resolvedModelFor(id: string): Promise<string> {
    const captured: CapturedEvent[] = [];
    setPostHogFlags(fakeFlags(captured));
    await withCapturedWarnings(async () => {
      const call = getStrategyLLM(id);
      await assert.rejects(() => call('hi'), /API key not configured/);
    });
    return String(captured[0].properties?.model);
  }

  it('uses defaultModel, not a model borrowed from another entry', async () => {
    writeConfig(fallbackConfig());
    assert.equal(await resolvedModelFor('not-in-the-config'), 'the-declared-default-model');
  });

  it('resolves the same model whichever order the strategies are declared in', async () => {
    const seen: string[] = [];
    for (const firstModel of ['model-A-declared-first', 'model-B-declared-first']) {
      resetLLMConfigCache();
      resetLLMRegistryCache();
      // Only the model of the FIRST declared entry changes between the two
      // rounds — under the old lookup that alone flipped the fallback.
      writeConfig(fallbackConfig(firstModel));
      seen.push(await resolvedModelFor('not-in-the-config'));
    }
    assert.deepEqual(seen, ['the-declared-default-model', 'the-declared-default-model']);
  });

  it('fails with an actionable message when defaultModel is absent', () => {
    const cfg = fallbackConfig();
    delete (cfg as Record<string, unknown>).defaultModel;
    writeConfig(cfg);
    // Mapped strategies still resolve — only the fallback path errors.
    assert.equal(typeof getStrategyLLM('first-entry'), 'function');
    assert.throws(
      () => getStrategyLLM('not-in-the-config'),
      /Strategy "not-in-the-config" has no entry .* declare defaultModel or an explicit strategy entry/s,
    );
  });

  it('a config without defaultModel still loads (backwards compatible)', () => {
    const cfg = fallbackConfig();
    delete (cfg as Record<string, unknown>).defaultModel;
    writeConfig(cfg);
    assert.equal(loadLLMConfig().defaultModel, undefined);
  });

  it('warns once per unmapped strategyId, naming the id and the fallback', async () => {
    writeConfig(fallbackConfig());
    const lines = await withCapturedWarnings(() => {
      getStrategyLLM('unmapped-one');
      getStrategyLLM('unmapped-one');        // same id, cached call
      getStrategyLogprobLLM('unmapped-one'); // same id, other capability
      getStrategyLLM('unmapped-two');
    });
    const forOne = lines.filter((l) => l.includes('"unmapped-one"'));
    assert.equal(forOne.length, 1, `expected exactly one warning, got ${JSON.stringify(lines)}`);
    assert.match(forOne[0], /no entry in llm\.config\.json/);
    assert.match(forOne[0], /provider "opencode"/);
    assert.match(forOne[0], /model "the-declared-default-model"/);
    assert.equal(lines.filter((l) => l.includes('"unmapped-two"')).length, 1);
  });

  it('says nothing for a strategy that has an explicit entry', async () => {
    writeConfig(fallbackConfig());
    const lines = await withCapturedWarnings(() => { getStrategyLLM('first-entry'); });
    assert.deepEqual(lines, []);
  });
});

// ─── Resolution never precedes the override/cache short-circuit ──────────────
//
// Regression guard for the defect that made `render:wardley-map:image:parse:png`
// unusable: `callFor` read llm.config.json BEFORE consulting the test override,
// so every resolution threw "Cannot read LLM config" wherever that per-user,
// git-ignored file is absent — a fresh clone, a git worktree, a CI runner —
// even for a call a test had explicitly stubbed. The vision strategy swallowed
// the throw into its degradation path and reported "no vision-capable LLM
// available", pointing at the provider instead of the missing file.

describe('registry — resolution order vs. missing config', () => {
  it('serves a test override with no llm.config.json on disk at all', async () => {
    process.env.WARDLEY_LLM_CONFIG = join(dir, 'absent.llm.config.json');
    const stub = async () => 'MAP_START{}MAP_END';
    setLLMCallForTesting('render-image-parse-png', 'vision', stub);
    const call = getStrategyVisionLLM('render-image-parse-png');
    assert.equal(call, stub);
    assert.equal(await call(''), 'MAP_START{}MAP_END');
  });

  it('still reports the missing file when nothing is stubbed', () => {
    process.env.WARDLEY_LLM_CONFIG = join(dir, 'absent.llm.config.json');
    assert.throws(
      () => getStrategyVisionLLM('render-image-parse-png'),
      /Cannot read LLM config at/,
    );
  });

  it('does not re-read the config for an already resolved call', () => {
    writeConfig(fullValidConfig());
    const first = getStrategyLLM('publication-analysis');
    // The file disappears; the cached call must survive it.
    rmSync(join(dir, 'llm.config.json'));
    assert.equal(getStrategyLLM('publication-analysis'), first);
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
