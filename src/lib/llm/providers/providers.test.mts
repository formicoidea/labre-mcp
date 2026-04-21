import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSdkProvider } from './agent-sdk-provider.mjs';
import { createHttpApiProvider } from './http-api-provider.mjs';
import { createCopilotSdkProvider } from './copilot-sdk-provider.mjs';
import { UnsupportedCapabilityError } from './provider.types.mjs';

describe('agent-sdk provider', () => {
  const p = createAgentSdkProvider();

  it('advertises text + structured, not logprobs', () => {
    assert.deepEqual(p.supports, { text: true, structured: true, logprobs: false });
  });

  it('exposes a callable text function', () => {
    const call = p.text({ provider: 'x', model: 'claude-sonnet-4-6', effort: 'low' });
    assert.equal(typeof call, 'function');
  });

  it('exposes a callable structured function', () => {
    const call = p.structured(
      { provider: 'x', model: 'claude-sonnet-4-6' },
      { type: 'object' },
    );
    assert.equal(typeof call, 'function');
  });

  it('throws UnsupportedCapabilityError for logprobs', () => {
    assert.throws(
      () => p.logprobs({ provider: 'x', model: 'claude-sonnet-4-6' }),
      UnsupportedCapabilityError,
    );
  });
});

describe('http-api provider', () => {
  const p = createHttpApiProvider({ kind: 'http-api', baseUrl: 'https://example.com/v1', apiKeyEnv: 'DUMMY_KEY' });

  it('advertises text + logprobs, not structured', () => {
    assert.deepEqual(p.supports, { text: true, structured: false, logprobs: true });
  });

  it('exposes a callable text function', () => {
    const call = p.text({ provider: 'x', model: 'kimi-k2.5', temperature: 0 });
    assert.equal(typeof call, 'function');
  });

  it('exposes a callable logprobs function', () => {
    const call = p.logprobs({ provider: 'x', model: 'kimi-k2.5', topLogprobs: 5 });
    assert.equal(typeof call, 'function');
  });

  it('throws UnsupportedCapabilityError for structured', () => {
    assert.throws(
      () => p.structured({ provider: 'x', model: 'kimi-k2.5' }, { type: 'object' }),
      UnsupportedCapabilityError,
    );
  });
});

describe('copilot-sdk provider', () => {
  const p = createCopilotSdkProvider({ kind: 'copilot-sdk', authEnv: 'COPILOT_GITHUB_TOKEN' });

  it('advertises text + structured, not logprobs', () => {
    assert.deepEqual(p.supports, { text: true, structured: true, logprobs: false });
  });

  it('exposes a callable text function', () => {
    const call = p.text({ provider: 'x', model: 'gpt-5' });
    assert.equal(typeof call, 'function');
  });

  it('exposes a callable structured function', () => {
    const call = p.structured(
      { provider: 'x', model: 'gpt-5' },
      { type: 'object' },
    );
    assert.equal(typeof call, 'function');
  });

  it('throws UnsupportedCapabilityError for logprobs', () => {
    assert.throws(
      () => p.logprobs({ provider: 'x', model: 'gpt-5' }),
      UnsupportedCapabilityError,
    );
  });
});
