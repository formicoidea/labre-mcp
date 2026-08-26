import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertQuotaOk,
  isOverBudget,
  noteKeyBudgetDenied,
  forgetKeyBudgetDenial,
  resetKeyBudgetDenials,
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
    resetKeyBudgetDenials();
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'anon';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetKeyBudgetDenials();
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

  it('never asks get_my_ai_usage for a lab_ key (not a JWT — the RPC sees no auth.uid())', async () => {
    respond(usage(300000, 300000));
    await runWithLedgerAuth('lab_deadbeef', () => assertQuotaOk());
    assert.equal(calls, 0);
  });

  it('refuses a lab_ key whose spend labre REFUSED on the previous run — the budget answer is honoured, not re-derived', async () => {
    respond(usage(1, 300000)); // would allow, if it were consulted at all
    noteKeyBudgetDenied('lab_spent', 310000, 300000);
    await assert.rejects(
      () => runWithLedgerAuth('lab_spent', () => assertQuotaOk()),
      (e: unknown) =>
        e instanceof QuotaExceededError && e.used === 310000 && e.limit === 300000,
    );
    // The refusal is local: no budget round-trip was made for it.
    assert.equal(calls, 0);
  });

  it('refuses only the key that was refused — a memo never spills onto another caller', async () => {
    noteKeyBudgetDenied('lab_spent', 310000, 300000);
    await runWithLedgerAuth('lab_other', () => assertQuotaOk());
  });

  it('forgets the refusal as soon as the budget answers yes again', async () => {
    noteKeyBudgetDenied('lab_spent', 310000, 300000);
    forgetKeyBudgetDenial('lab_spent');
    await runWithLedgerAuth('lab_spent', () => assertQuotaOk());
  });

  it('degrades OPEN once the memo has expired — a rolling-hour budget refills, so a memo may never become a ban', async () => {
    const realNow = Date.now;
    try {
      noteKeyBudgetDenied('lab_spent', 310000, 300000);
      Date.now = () => realNow() + 61_000;
      await runWithLedgerAuth('lab_spent', () => assertQuotaOk());
    } finally {
      Date.now = realNow;
    }
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
