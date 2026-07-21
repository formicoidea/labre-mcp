import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reportUsageToLedger } from './ledger-report.mjs';
import { runWithLedgerAuth } from './ledger-auth-context.mjs';
import type { LlmUsageRecord } from './usage-context.mjs';

// A JWT-shaped token (three base64url segments). The reporter only checks it is
// not a lab_ key; it never decodes it — PostgREST does.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig';

const RECORDS: LlmUsageRecord[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 40 },
  { provider: 'copilot-sdk', model: 'gpt-5' }, // no token numbers (the known gap)
];

describe('reportUsageToLedger', () => {
  let calls: { url: string; init: RequestInit }[];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'anon';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it('writes one ai_calls row per call, under the caller JWT', async () => {
    await runWithLedgerAuth(JWT, () => reportUsageToLedger(RECORDS));
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'http://supabase.test/rest/v1/ai_calls');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${JWT}`);
    assert.equal(headers.apikey, 'anon');
    const body = JSON.parse(String(init.body)) as unknown[];
    assert.equal(body.length, 2);
    // user_id is never sent — the DB stamps it from auth.uid().
    assert.deepEqual(body[0], {
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 40,
      source: 'mcp',
    });
    // The token-less Copilot call still records (0 tokens), model falls back to
    // provider only when absent — here it carried one.
    assert.deepEqual(body[1], {
      model: 'gpt-5',
      input_tokens: 0,
      output_tokens: 0,
      source: 'mcp',
    });
  });

  it('is a no-op with no caller JWT (stdio / tests)', async () => {
    await reportUsageToLedger(RECORDS);
    assert.equal(calls.length, 0);
  });

  it('skips lab_ API-key callers (not a JWT — auth.uid() would be null)', async () => {
    await runWithLedgerAuth('lab_deadbeef', () => reportUsageToLedger(RECORDS));
    assert.equal(calls.length, 0);
  });

  it('is a no-op when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    await runWithLedgerAuth(JWT, () => reportUsageToLedger(RECORDS));
    assert.equal(calls.length, 0);
  });

  it('is a no-op with nothing to report', async () => {
    await runWithLedgerAuth(JWT, () => reportUsageToLedger([]));
    assert.equal(calls.length, 0);
  });

  it('never throws when the ledger write fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await runWithLedgerAuth(JWT, () => reportUsageToLedger(RECORDS));
    // reaching here without throwing is the assertion
    assert.ok(true);
  });
});
