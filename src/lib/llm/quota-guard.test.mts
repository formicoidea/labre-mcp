import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertQuotaOk,
  isOverBudget,
  QuotaExceededError,
} from './quota-guard.mjs';
import { runWithLedgerAuth } from './ledger-auth-context.mjs';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig';

const usage = (used: number, limit: number) => [
  { tokens_this_hour: used, tokens_limit_hour: limit },
];

describe('isOverBudget (pure)', () => {
  it('refuses only on a well-formed row at or over a positive limit', () => {
    assert.equal(isOverBudget(usage(300000, 300000)), true);
    assert.equal(isOverBudget(usage(400000, 300000)), true);
    assert.equal(isOverBudget(usage(1, 300000)), false);
  });

  it('handles PostgREST bigints serialised as strings', () => {
    assert.equal(
      isOverBudget([{ tokens_this_hour: '300000', tokens_limit_hour: '300000' }]),
      true,
    );
  });

  it('degrades OPEN on anything unreadable — a denial needs a real answer', () => {
    assert.equal(isOverBudget(null), false);
    assert.equal(isOverBudget({}), false);
    assert.equal(isOverBudget([{}]), false);
    assert.equal(isOverBudget('nope'), false);
    // A non-positive limit is "no limit stated", not "no budget".
    assert.equal(isOverBudget(usage(10, 0)), false);
  });

  it('treats a 0 limit with usage as allowed, but a launch-time 0 budget is the plan gate', () => {
    // ADR-0030 D4 sets free.tokens_per_hour = 0. The SQL resolution never
    // returns a 0 limit today; when it does, `used >= limit` is the refusal —
    // guarded above by `limit > 0`, so this documents the seam rather than
    // asserting a behaviour that is not wired yet.
    assert.equal(isOverBudget(usage(0, 0)), false);
  });
});

describe('assertQuotaOk', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'anon';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  const respond = (body: unknown, status = 200) => {
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  };

  it('refuses a hosted run whose budget is spent', async () => {
    respond(usage(300000, 300000));
    await assert.rejects(
      () => runWithLedgerAuth(JWT, () => assertQuotaOk()),
      (e: unknown) => e instanceof QuotaExceededError && e.used === 300000,
    );
  });

  it('allows a run under budget', async () => {
    respond(usage(10, 300000));
    await runWithLedgerAuth(JWT, () => assertQuotaOk());
    assert.equal(calls, 1);
  });

  it('never runs off the hosted daemon (no caller JWT = local/stdio)', async () => {
    respond(usage(300000, 300000));
    await assertQuotaOk(); // would refuse if it asked at all
    assert.equal(calls, 0);
  });

  it('skips lab_ API keys (not a JWT — the RPC sees no auth.uid())', async () => {
    respond(usage(300000, 300000));
    await runWithLedgerAuth('lab_deadbeef', () => assertQuotaOk());
    assert.equal(calls, 0);
  });

  it('degrades OPEN when the budget read fails', async () => {
    respond({ error: 'boom' }, 500);
    await runWithLedgerAuth(JWT, () => assertQuotaOk());
  });

  it('degrades OPEN when the network throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await runWithLedgerAuth(JWT, () => assertQuotaOk());
  });
});
