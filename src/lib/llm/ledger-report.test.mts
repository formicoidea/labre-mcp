import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reportUsageToLedger } from './ledger-report.mjs';
import { runWithLedgerAuth } from './ledger-auth-context.mjs';
import {
  assertQuotaOk,
  resetKeyBudgetDenials,
  QuotaExceededError,
} from './quota-guard.mjs';
import type { LlmUsageRecord } from './usage-context.mjs';

// A JWT-shaped token (three base64url segments). The reporter only checks it is
// not a lab_ key; it never decodes it — PostgREST does.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig';

// A lab_ personal API key. Opaque by construction — the reporter never parses
// it, never logs it, and hands it to the RPC as an argument.
const KEY = 'lab_deadbeef';

const RECORDS: LlmUsageRecord[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 40 },
  { provider: 'copilot-sdk', model: 'gpt-5' }, // no token numbers (the known gap)
];

describe('reportUsageToLedger', () => {
  let calls: { url: string; init: RequestInit }[];
  const realFetch = globalThis.fetch;

  /** Re-arm the fake fetch with a JSON body (the key-side RPC answers one). */
  const respondWith = (body: unknown) => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  };

  beforeEach(() => {
    calls = [];
    resetKeyBudgetDenials();
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'anon';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetKeyBudgetDenials();
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

  it('routes a lab_ API-key caller through record_mcp_key_spend — one RPC per call, the key as data, no session', async () => {
    respondWith([{ status: 'recorded', tokens_used: 140, tokens_limit: 300000 }]);
    await runWithLedgerAuth(KEY, () => reportUsageToLedger(RECORDS));

    // One call per record, not one batch: the RPC records a single spend.
    assert.equal(calls.length, 2);
    const { url, init } = calls[0];
    assert.equal(url, 'http://supabase.test/rest/v1/rpc/record_mcp_key_spend');
    const headers = init.headers as Record<string, string>;
    // The daemon holds no privileged credential: it authenticates as anon and
    // presents the key as an argument — the same door validate_api_key uses.
    assert.equal(headers.apikey, 'anon');
    assert.equal(headers.authorization, 'Bearer anon');
    assert.equal(headers['content-profile'], 'labre_mcp');
    assert.deepEqual(JSON.parse(String(init.body)), {
      p_key: KEY,
      p_model: 'claude-sonnet-4-6',
      p_input_tokens: 100,
      p_output_tokens: 40,
    });
    // The token-less Copilot call still records (0 tokens): the sentinel counts
    // CALLS, so dropping one would re-open the hole this path closes.
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
      p_key: KEY,
      p_model: 'gpt-5',
      p_input_tokens: 0,
      p_output_tokens: 0,
    });
    // Nothing was refused, so nothing is memoised against the key.
    await runWithLedgerAuth(KEY, () => assertQuotaOk());
  });

  it('memoises a `denied` so the key\'s NEXT run is refused before it spends — and stops asking for the rest of this one', async () => {
    respondWith([{ status: 'denied', tokens_used: 310000, tokens_limit: 300000 }]);
    await runWithLedgerAuth(KEY, () => reportUsageToLedger(RECORDS));

    // Two records, ONE call: the same budget would refuse the second.
    assert.equal(calls.length, 1);
    await assert.rejects(
      () => runWithLedgerAuth(KEY, () => assertQuotaOk()),
      (e: unknown) =>
        e instanceof QuotaExceededError &&
        e.code === 'quota-exceeded' &&
        e.used === 310000 &&
        e.limit === 300000,
    );
  });

  it('swallows an `invalid-key` answer — a metering write never fails the run, and the door already refused it', async () => {
    respondWith([{ status: 'invalid-key', tokens_used: 0, tokens_limit: 0 }]);
    await runWithLedgerAuth(KEY, () => reportUsageToLedger(RECORDS));
    assert.equal(calls.length, 2);
    // 0/0 is not a budget answer: it must never become a refusal.
    await runWithLedgerAuth(KEY, () => assertQuotaOk());
  });

  it('degrades OPEN on an unreadable RPC answer — no memo, no refusal', async () => {
    respondWith({ nonsense: true });
    await runWithLedgerAuth(KEY, () => reportUsageToLedger(RECORDS));
    await runWithLedgerAuth(KEY, () => assertQuotaOk());
  });

  it('never throws when the key-side write fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await runWithLedgerAuth(KEY, () => reportUsageToLedger(RECORDS));
    await runWithLedgerAuth(KEY, () => assertQuotaOk());
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
