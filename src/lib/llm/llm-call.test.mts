// Unit tests for llm-call: interpolation + OpenCode provider routing with stubbed fetch.
// Real Agent SDK / OpenCode network calls are intentionally out of scope.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, createOpenCodeCall, createOpenCodeLogprobCall } from './llm-call.mjs';

describe('interpolate', () => {
  it('replaces {{var}} placeholders', () => {
    assert.equal(
      interpolate('Hello {{name}}, you are {{age}}', { name: 'World', age: 42 }),
      'Hello World, you are 42',
    );
  });

  it('returns template unchanged when variables map is empty', () => {
    assert.equal(interpolate('No vars here', {}), 'No vars here');
  });

  it('returns template unchanged when variables is undefined', () => {
    assert.equal(interpolate('Plain template'), 'Plain template');
  });

  it('preserves placeholder when variable is missing', () => {
    assert.equal(
      interpolate('Missing {{unknown}}', { other: 'val' }),
      'Missing {{unknown}}',
    );
  });

  it('stringifies numeric and boolean values', () => {
    assert.equal(interpolate('{{n}}/{{b}}', { n: 3, b: true }), '3/true');
  });
});

// ─── OpenCode fetch stubbing ────────────────────────────────────────────────

describe('createOpenCodeCall — fetch stubbed', () => {
  let originalFetch: typeof fetch;
  let capturedUrl: string | undefined;
  let capturedBody: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws a clear error when apiKey is missing', async () => {
    const call = createOpenCodeCall({ apiKey: undefined });
    await assert.rejects(() => call('hello', {}), /OPENCODE_API_KEY/);
  });

  it('POSTs interpolated prompt to the configured baseUrl', async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '42' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const call = createOpenCodeCall({ apiKey: 'test-key', baseUrl: 'https://example.test/v1' });
    const result = await call('Solve {{q}}', { q: '2+2' });

    assert.equal(result, '42');
    assert.equal(capturedUrl, 'https://example.test/v1/chat/completions');
    assert.equal(capturedBody.messages[0].content, 'Solve 2+2');
  });

  it('throws when the response status is not OK', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const call = createOpenCodeCall({ apiKey: 'k' });
    await assert.rejects(() => call('x', {}), /OpenCode API error 500/);
  });

  it('throws when the response has no content', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 })) as typeof fetch;
    const call = createOpenCodeCall({ apiKey: 'k' });
    await assert.rejects(() => call('x', {}), /empty response/);
  });
});

describe('createOpenCodeLogprobCall — fetch stubbed', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the parsed text and logprobs (top token + alternatives)', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({
        choices: [{
          message: { content: 'Commodity' },
          logprobs: {
            content: [{
              token: 'Commodity',
              logprob: -0.1,
              top_logprobs: [
                { token: 'Commodity', logprob: -0.1 },
                { token: 'Product', logprob: -1.2 },
              ],
            }],
          },
        }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

    const call = createOpenCodeLogprobCall({ apiKey: 'k' });
    const { text, logprobs } = await call('Classify {{x}}', { x: 'Electricity' });

    assert.equal(text, 'Commodity');
    assert.equal(logprobs.length, 2);
    assert.equal(logprobs[0].token, 'Commodity');
    assert.equal(logprobs[1].token, 'Product');
  });

  it('throws when apiKey missing', async () => {
    const call = createOpenCodeLogprobCall({ apiKey: undefined });
    await assert.rejects(() => call('x', {}), /OPENCODE_API_KEY/);
  });
});
