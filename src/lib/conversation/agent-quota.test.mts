// Unit tests for the pure daily agent-turn quota decision (ADR-0027 D3/D4).
// Fail-open is the contract under test: a deny requires a positive,
// well-formed budget answer; everything else allows.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentQuotaDecision, QuotaExceededError } from './agent-quota.mjs';

const row = (today: unknown, limit: unknown): unknown => [
  { agent_turns_today: today, agent_turns_limit_day: limit },
];

describe('agentQuotaDecision', () => {
  it('allows when the RPC read failed (ok=false), whatever the body — no degraded flag (the caller observes ok itself)', () => {
    assert.deepEqual(agentQuotaDecision(false, row(999, 1)), { decision: 'allow' });
    assert.deepEqual(agentQuotaDecision(false, undefined), { decision: 'allow' });
  });

  it('allows WITH degraded flag on malformed bodies (null, string, empty array, non-object row)', () => {
    // Schema drift must be observable: a malformed-but-ok reply is a degraded
    // allow, so the caller can capture QuotaCheckDegraded.
    assert.deepEqual(agentQuotaDecision(true, null), { decision: 'allow', degraded: true });
    assert.deepEqual(agentQuotaDecision(true, 'oops'), { decision: 'allow', degraded: true });
    assert.deepEqual(agentQuotaDecision(true, []), { decision: 'allow', degraded: true });
    assert.deepEqual(agentQuotaDecision(true, ['not-a-row']), {
      decision: 'allow',
      degraded: true,
    });
  });

  it('allows WITH degraded flag when the limit field is absent or non-numeric', () => {
    assert.deepEqual(agentQuotaDecision(true, [{ agent_turns_today: 10 }]), {
      decision: 'allow',
      degraded: true,
    });
    assert.deepEqual(agentQuotaDecision(true, row(10, 'abc')), {
      decision: 'allow',
      degraded: true,
    });
  });

  it('allows on a non-positive limit WITHOUT degraded flag (legitimate "no limit" config)', () => {
    assert.deepEqual(agentQuotaDecision(true, row(10, 0)), { decision: 'allow' });
    assert.deepEqual(agentQuotaDecision(true, row(10, -5)), { decision: 'allow' });
  });

  it('allows strictly below the limit', () => {
    assert.deepEqual(agentQuotaDecision(true, row(49, 50)), { decision: 'allow' });
    assert.deepEqual(agentQuotaDecision(true, row(0, 1)), { decision: 'allow' });
  });

  it('denies exactly at the boundary (used == limit) carrying the numbers', () => {
    assert.deepEqual(agentQuotaDecision(true, row(50, 50)), {
      decision: 'deny',
      used: 50,
      limit: 50,
    });
  });

  it('denies above the limit', () => {
    assert.deepEqual(agentQuotaDecision(true, row(51, 50)), {
      decision: 'deny',
      used: 51,
      limit: 50,
    });
  });

  it('coerces PostgREST string-serialized bigints', () => {
    // count(*)::bigint may arrive as a JSON string depending on the path.
    assert.deepEqual(agentQuotaDecision(true, row('50', '50')), {
      decision: 'deny',
      used: 50,
      limit: 50,
    });
    assert.deepEqual(agentQuotaDecision(true, row('3', 50)), { decision: 'allow' });
  });

  it('accepts a bare (non-array) row object too', () => {
    assert.deepEqual(
      agentQuotaDecision(true, { agent_turns_today: 7, agent_turns_limit_day: 7 }),
      { decision: 'deny', used: 7, limit: 7 },
    );
  });

  it('treats an unreadable used as 0 (allow) when the limit is positive', () => {
    assert.deepEqual(agentQuotaDecision(true, row('nope', 50)), { decision: 'allow' });
  });
});

describe('QuotaExceededError', () => {
  it('carries used/limit and a numbers-only message', () => {
    const err = new QuotaExceededError(51, 50);
    assert.equal(err.used, 51);
    assert.equal(err.limit, 50);
    assert.equal(err.name, 'QuotaExceededError');
    assert.match(err.message, /51\/50/);
    assert.ok(err instanceof Error);
  });
});
