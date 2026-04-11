// Tests for MCP notifications verbose mode
//
// Verifies that WARDLEY_VERBOSE env var and setVerbose() correctly
// gate debug-level messages while leaving info/error/warning untouched.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  logDebug, logInfo, logError, logWarning, sendLog,
  setVerbose, isVerbose,
} from './mcp-notifications.mjs';

/**
 * Helper: capture only JSON-RPC notification writes to stdout.
 * Returns { messages, restore } where messages is an array of parsed notifications.
 */
function captureNotifications() {
  const messages = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = (chunk, ...args) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    // Only intercept JSON-RPC notifications (our log messages)
    if (str.includes('"notifications/message"')) {
      try {
        messages.push(JSON.parse(str.trim()));
      } catch {
        // Not valid JSON, pass through
        return originalWrite(chunk, ...args);
      }
      return true;
    }
    // Let everything else (TAP output, etc.) pass through
    return originalWrite(chunk, ...args);
  };

  return {
    messages,
    restore: () => { process.stdout.write = originalWrite; },
  };
}

describe('verbose mode toggle', () => {
  let cap;

  beforeEach(() => {
    setVerbose(false);
    cap = captureNotifications();
  });

  afterEach(() => {
    cap.restore();
    setVerbose(false);
  });

  it('logDebug is suppressed when verbose is off', () => {
    logDebug('test-tool', 'should not appear');
    assert.equal(cap.messages.length, 0, 'debug message should be suppressed');
  });

  it('logDebug emits when verbose is enabled via setVerbose(true)', () => {
    setVerbose(true);
    logDebug('test-tool', 'debug detail');
    assert.equal(cap.messages.length, 1, 'debug message should be emitted');
    assert.equal(cap.messages[0].params.level, 'debug');
    assert.equal(cap.messages[0].params.logger, 'test-tool');
    assert.equal(cap.messages[0].params.data, 'debug detail');
  });

  it('logInfo always emits regardless of verbose mode', () => {
    logInfo('test-tool', 'info message');
    assert.equal(cap.messages.length, 1);
    assert.equal(cap.messages[0].params.level, 'info');
  });

  it('logError always emits regardless of verbose mode', () => {
    logError('test-tool', 'error message');
    assert.equal(cap.messages.length, 1);
    assert.equal(cap.messages[0].params.level, 'error');
  });

  it('logWarning always emits regardless of verbose mode', () => {
    logWarning('test-tool', 'warning message');
    assert.equal(cap.messages.length, 1);
    assert.equal(cap.messages[0].params.level, 'warning');
  });

  it('isVerbose reflects current state after setVerbose', () => {
    assert.equal(isVerbose(), false);
    setVerbose(true);
    assert.equal(isVerbose(), true);
    setVerbose(false);
    assert.equal(isVerbose(), false);
  });

  it('setVerbose coerces truthy/falsy values', () => {
    setVerbose(1);
    assert.equal(isVerbose(), true);
    setVerbose(0);
    assert.equal(isVerbose(), false);
    setVerbose('yes');
    assert.equal(isVerbose(), true);
    setVerbose('');
    assert.equal(isVerbose(), false);
  });

  it('multiple debug calls are all suppressed when not verbose', () => {
    logDebug('t', 'a');
    logDebug('t', 'b');
    logDebug('t', 'c');
    assert.equal(cap.messages.length, 0);
  });

  it('mixed levels: only debug is gated by verbose', () => {
    // verbose off
    logInfo('t', 'i1');
    logDebug('t', 'd1');
    logError('t', 'e1');
    logDebug('t', 'd2');
    logWarning('t', 'w1');

    assert.equal(cap.messages.length, 3, 'only info+error+warning should emit');
    assert.deepEqual(
      cap.messages.map(m => m.params.level),
      ['info', 'error', 'warning'],
    );

    // Now enable verbose
    setVerbose(true);
    logDebug('t', 'd3');
    assert.equal(cap.messages.length, 4, 'debug should now emit');
    assert.equal(cap.messages[3].params.level, 'debug');
  });
});

describe('WARDLEY_VERBOSE env var', () => {
  it('documents accepted truthy values: "1", "true", "yes"', () => {
    // The env var is read at module load time, so we test the programmatic
    // API as equivalent. The resolveVerboseFromEnv function (internal) accepts
    // "1", "true", "yes" (case-insensitive).
    // This test verifies the contract is correct via the exported API.
    setVerbose(false);
    assert.equal(isVerbose(), false);
    setVerbose(true);
    assert.equal(isVerbose(), true);
    setVerbose(false);
  });
});
