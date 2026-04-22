// Tests for DegradationCollector — covers event recording, flag computation,
// merging, and the side-effect emission of MCP log notifications.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DegradationCollector } from './collector.mjs';
import { setVerbose } from '../mcp-notifications.mjs';

interface CapturedNotification {
  method: string;
  params: { level: string; logger: string; data: string };
}

function captureNotifications(): { messages: CapturedNotification[]; restore: () => void } {
  const messages: CapturedNotification[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  // any: monkey-patching process.stdout.write — Node's overload signatures resist clean typing
  (process.stdout as any).write = (chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('"notifications/message"')) {
      try {
        messages.push(JSON.parse(str.trim()));
      } catch {
        return originalWrite(chunk, ...args);
      }
      return true;
    }
    if (str.includes('"notifications/claude/channel"')) {
      // Swallow channel notifications so test output stays clean.
      return true;
    }
    return originalWrite(chunk, ...args);
  };

  return {
    messages,
    restore: () => {
      (process.stdout as any).write = originalWrite;
    },
  };
}

describe('DegradationCollector', () => {
  let cap: ReturnType<typeof captureNotifications>;

  beforeEach(() => {
    setVerbose(false);
    cap = captureNotifications();
  });

  afterEach(() => {
    cap.restore();
  });

  it('starts non-degraded with no events', () => {
    const c = new DegradationCollector('test-tool');
    assert.equal(c.hasDegraded(), false);
    assert.deepEqual(c.getEvents(), []);
    const wrapped = c.wrap({ value: 42 });
    assert.equal(wrapped.degraded, false);
    assert.deepEqual(wrapped.degradationEvents, []);
    assert.deepEqual(wrapped.result, { value: 42 });
  });

  it('record() with severity warning sets degraded and emits a warning notification', () => {
    const c = new DegradationCollector('tool-a');
    c.record({
      source: 'bigquery',
      reason: 'project id missing',
      severity: 'warning',
      recoverable: false,
    });
    assert.equal(c.hasDegraded(), true);
    const events = c.getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'bigquery');
    assert.ok(events[0].at, 'auto-fills ISO timestamp');

    const warnings = cap.messages.filter((m) => m.params.level === 'warning');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].params.logger, 'tool-a');
    assert.match(warnings[0].params.data, /\[bigquery\] project id missing/);
  });

  it('record() with severity info does NOT set degraded', () => {
    const c = new DegradationCollector('tool-b');
    c.record({
      source: 'cache',
      reason: 'cold start',
      severity: 'info',
      recoverable: true,
    });
    assert.equal(c.hasDegraded(), false);
    const wrapped = c.wrap('ok');
    assert.equal(wrapped.degraded, false);
    assert.equal(wrapped.degradationEvents.length, 1);
  });

  it('recordError extracts the message and defaults to recoverable warning', () => {
    const c = new DegradationCollector('tool-c');
    c.recordError('cpc-mapper', new Error('timeout after 30s'));
    const evt = c.getEvents()[0];
    assert.equal(evt.source, 'cpc-mapper');
    assert.equal(evt.reason, 'timeout after 30s');
    assert.equal(evt.severity, 'warning');
    assert.equal(evt.recoverable, true);
    assert.deepEqual(evt.detail, { error: 'timeout after 30s' });
  });

  it('recordError with recoverable:false flips the flag', () => {
    const c = new DegradationCollector('tool-d');
    c.recordError('llm:opencode', new Error('401 unauthorized'), { recoverable: false });
    const evt = c.getEvents()[0];
    assert.equal(evt.recoverable, false);
  });

  it('recordError uses provided severity', () => {
    const c = new DegradationCollector('tool-e');
    c.recordError('llm:claude', new Error('rate limit'), { severity: 'error' });
    const errors = cap.messages.filter((m) => m.params.level === 'error');
    assert.equal(errors.length, 1);
  });

  it('merge() copies events and propagates degraded flag without re-emitting logs', () => {
    const a = new DegradationCollector('parent');
    const b = new DegradationCollector('child');
    b.record({ source: 'web-search', reason: 'rate limited', severity: 'warning', recoverable: true });

    cap.messages.length = 0; // reset capture before the merge

    a.merge(b);
    assert.equal(a.hasDegraded(), true);
    assert.equal(a.getEvents().length, 1);
    assert.equal(a.getEvents()[0].source, 'web-search');
    assert.equal(cap.messages.length, 0, 'merge() must not re-emit notifications');
  });

  it('wrap() yields a Degradable envelope reflecting the current state', () => {
    const c = new DegradationCollector('tool-f');
    c.record({ source: 'x', reason: 'r', severity: 'warning', recoverable: true });
    const wrapped = c.wrap({ ok: true });
    assert.equal(wrapped.degraded, true);
    assert.deepEqual(wrapped.result, { ok: true });
    assert.equal(wrapped.degradationEvents.length, 1);
  });

  it('getEvents() returns a defensive copy', () => {
    const c = new DegradationCollector('tool-g');
    c.record({ source: 'x', reason: 'r', severity: 'info', recoverable: true });
    const snapshot = c.getEvents();
    snapshot.push({ source: 'mut', reason: 'mut', severity: 'warning', recoverable: true, at: 'now' });
    assert.equal(c.getEvents().length, 1, 'mutations to snapshot must not affect collector');
  });
});
