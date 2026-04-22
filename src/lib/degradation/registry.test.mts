// Tests for the health-check registry.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerHealthCheck,
  runHealthCheck,
  runAllHealthChecks,
  hasHealthCheck,
  listHealthChecks,
  clearRegistry,
} from './registry.mjs';

describe('health-check registry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('returns null when the dependency is ready', async () => {
    registerHealthCheck('foo', async () => ({ ready: true }));
    const event = await runHealthCheck('foo');
    assert.equal(event, null);
  });

  it('returns a warning event when the dependency is not ready', async () => {
    registerHealthCheck('foo', async () => ({
      ready: false,
      reason: 'missing API key',
      detail: { missing: ['FOO_API_KEY'] },
    }));
    const event = await runHealthCheck('foo');
    assert.ok(event);
    assert.equal(event!.source, 'foo');
    assert.equal(event!.severity, 'warning');
    assert.equal(event!.recoverable, false);
    assert.equal(event!.reason, 'missing API key');
    assert.deepEqual(event!.detail, { missing: ['FOO_API_KEY'] });
    assert.ok(event!.at, 'event must carry an ISO timestamp');
  });

  it('returns a warning event when the check itself throws', async () => {
    registerHealthCheck('boom', async () => {
      throw new Error('connection refused');
    });
    const event = await runHealthCheck('boom');
    assert.ok(event);
    assert.match(event!.reason, /health check threw: connection refused/);
  });

  it('returns a warning event for an unknown source', async () => {
    const event = await runHealthCheck('not-registered');
    assert.ok(event);
    assert.match(event!.reason, /no health check registered/);
  });

  it('runAllHealthChecks returns only failing dependencies', async () => {
    registerHealthCheck('ok-1', async () => ({ ready: true }));
    registerHealthCheck('ok-2', async () => ({ ready: true }));
    registerHealthCheck('bad', async () => ({ ready: false, reason: 'down' }));

    const events = await runAllHealthChecks();
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'bad');
  });

  it('listHealthChecks reflects insertion order', () => {
    registerHealthCheck('a', async () => ({ ready: true }));
    registerHealthCheck('b', async () => ({ ready: true }));
    registerHealthCheck('c', async () => ({ ready: true }));
    assert.deepEqual(listHealthChecks(), ['a', 'b', 'c']);
  });

  it('hasHealthCheck reports registration state', () => {
    assert.equal(hasHealthCheck('x'), false);
    registerHealthCheck('x', async () => ({ ready: true }));
    assert.equal(hasHealthCheck('x'), true);
  });

  it('re-registering a source overwrites the previous check', async () => {
    registerHealthCheck('foo', async () => ({ ready: false, reason: 'first' }));
    registerHealthCheck('foo', async () => ({ ready: false, reason: 'second' }));
    const event = await runHealthCheck('foo');
    assert.equal(event!.reason, 'second');
  });

  it('supports synchronous health checks', async () => {
    registerHealthCheck('sync', () => ({ ready: false, reason: 'sync down' }));
    const event = await runHealthCheck('sync');
    assert.equal(event!.reason, 'sync down');
  });
});
