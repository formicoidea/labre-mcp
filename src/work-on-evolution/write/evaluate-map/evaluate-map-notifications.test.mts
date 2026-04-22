// Validation test for evaluateMap MCP progress notifications
//
// Validates the same notification pattern as the estimateEvolution pilot:
//   1. Info-level log at tool start and end (localized)
//   2. Debug-level log at intermediate steps (parsing, classification, progress, bestpick, file update)
//   3. Language detection from filePath args
//   4. Verbose mode gating (debug suppressed when off)
//   5. Existing tool output remains unchanged
//   6. Logger name consistency ("evaluateMap")
//   7. JSON-RPC 2.0 notification format compliance

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setVerbose } from '../../../lib/mcp-notifications.mjs';
import { evaluateMapFile } from './evaluate-map.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Capture JSON-RPC notifications written to stdout during test execution.
 * Only captures MCP log notifications (notifications/message), lets
 * TAP output and other writes pass through.
 */
function captureNotifications() {
  const messages = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = (chunk, ...args) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('"notifications/message"')) {
      try {
        messages.push(JSON.parse(str.trim()));
      } catch {
        return originalWrite(chunk, ...args);
      }
      return true;
    }
    return originalWrite(chunk, ...args);
  };

  return {
    messages,
    restore: () => { process.stdout.write = originalWrite; },
  };
}

/** Extract notification levels from captured messages */
function levels(messages) {
  return messages.map(m => m.params.level);
}

/** Extract notification data (message text) from captured messages */
function dataTexts(messages) {
  return messages.map(m => m.params.data);
}

/** Filter messages by level */
function byLevel(messages, level) {
  return messages.filter(m => m.params.level === level);
}

// ─── Test Fixtures ────────────────────────────────────────────────────────

const TEST_WM_CONTENT = `title Tea Shop

anchor Business [0.95, 0.63]

component Cup of Tea [0.79, 0.61]
component Cup [0.73, 0.78]
component Tea [0.63, 0.45]
component Hot Water [0.52, 0.82]
component Kettle [0.32, 0.33]
component Power [0.11, 0.89]

Business->Cup of Tea
Cup of Tea->Cup
Cup of Tea->Tea
Cup of Tea->Hot Water
Hot Water->Kettle
Kettle->Power

style wardley`;

const TEST_WM_FRENCH = `title Boutique de Thé

anchor Commerce [0.95, 0.63]

component Tasse de Thé [0.79, 0.61]
component Bouilloire [0.32, 0.33]

Commerce->Tasse de Thé
Tasse de Thé->Bouilloire

style wardley`;

let tempDir;
let testFile;
let testFileFr;

async function createTempFiles() {
  tempDir = join(tmpdir(), `wardley-test-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  testFile = join(tempDir, 'tea-shop.wm');
  await writeFile(testFile, TEST_WM_CONTENT, 'utf-8');

  testFileFr = join(tempDir, 'boutique-the.wm');
  await writeFile(testFileFr, TEST_WM_FRENCH, 'utf-8');
}

async function cleanupTempFiles() {
  try {
    await unlink(testFile);
    await unlink(testFileFr);
    const { rmdir } = await import('node:fs/promises');
    await rmdir(tempDir);
  } catch {
    // Ignore cleanup errors
  }
}

// ─── evaluateMap Notification Validation Tests ────────────────────────────

describe('evaluateMap — progress notifications', () => {
  let cap;

  beforeEach(async () => {
    await createTempFiles();
    cap = captureNotifications();
  });

  afterEach(async () => {
    cap.restore();
    setVerbose(false);
    await cleanupTempFiles();
  });

  // ── AC: Info-level start/end messages ─────────────────────────────────

  it('emits info-level log at start and end for map evaluation', async () => {
    setVerbose(false); // debug suppressed, only info visible
    const result = await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: false,
    });

    // Result should be valid
    assert.ok(result.evaluations, 'evaluations present');
    assert.ok(result.summary, 'summary present');
    assert.ok(result.report, 'report present');

    // Info-level notifications at start and end
    const infoMsgs = byLevel(cap.messages, 'info');
    assert.ok(infoMsgs.length >= 2, `Expected at least 2 info messages, got ${infoMsgs.length}`);

    // First info: tool start with file path
    const startMsg = infoMsgs[0].params.data;
    assert.ok(startMsg.includes('evaluateMap') || startMsg.includes('tea-shop'), `Start message mentions tool or file: ${startMsg}`);

    // Last info: tool end with duration
    const endMsg = infoMsgs[infoMsgs.length - 1].params.data;
    assert.ok(/\d+/.test(endMsg), `End message includes duration: ${endMsg}`);
  });

  // ── AC: Debug messages at intermediate steps ──────────────────────────

  it('emits debug-level logs for intermediate steps when verbose is on', async () => {
    setVerbose(true);
    await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: false,
    });

    const debugMsgs = byLevel(cap.messages, 'debug');
    assert.ok(debugMsgs.length >= 3, `Expected at least 3 debug messages, got ${debugMsgs.length}`);

    const debugTexts = dataTexts(debugMsgs);

    // Check parsing step is logged
    const hasParsing = debugTexts.some(t => t.includes('component') && /\d+/.test(t));
    assert.ok(hasParsing, 'Debug should mention parsing with component count');

    // Check per-component progress is logged
    const hasProgress = debugTexts.some(t => /\d+\/\d+/.test(t));
    assert.ok(hasProgress, 'Debug should mention component progress (X/Y format)');

    // Check classification is logged
    const hasClassification = debugTexts.some(t =>
      t.includes('economic') || t.includes('social') || t.includes('classif') || t.includes('Classif')
    );
    assert.ok(hasClassification, 'Debug should mention classification');
  });

  it('suppresses debug messages when verbose is off', async () => {
    setVerbose(false);
    await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: false,
    });

    const debugMsgs = byLevel(cap.messages, 'debug');
    assert.equal(debugMsgs.length, 0, 'Debug messages should be suppressed when verbose is off');
  });

  // ── AC: File update debug notification ────────────────────────────────

  it('emits debug for file update when updateFile is true', async () => {
    setVerbose(true);
    await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: true,
    });

    const debugMsgs = byLevel(cap.messages, 'debug');
    const evalMapDebug = debugMsgs.filter(m => m.params.logger === 'evaluateMap');
    const debugTexts = dataTexts(evalMapDebug);
    const hasFileUpdate = debugTexts.some(t =>
      t.includes('.wm') || t.includes('Updating') || t.includes('Mise à jour') || t.includes('updat')
    );
    assert.ok(hasFileUpdate, `Debug should mention file update step. Got: ${debugTexts.join(' | ')}`);
  });

  // ── AC: Language detection ────────────────────────────────────────────

  it('emits English-localized messages for English file path', async () => {
    setVerbose(false);
    await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: false,
    });

    const infoMsgs = byLevel(cap.messages, 'info');
    assert.ok(infoMsgs.length >= 2, 'Should have start + end info messages');

    const startMsg = infoMsgs[0].params.data;
    assert.ok(
      startMsg.includes('Starting') || startMsg.includes('evaluateMap'),
      `English start message expected: ${startMsg}`
    );
  });

  // ── AC: Existing tool output unchanged ────────────────────────────────

  it('does not alter the returned result structure', async () => {
    setVerbose(true); // Even with verbose, output unchanged
    const result = await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: false,
    });

    // Verify result shape is identical
    assert.ok(result.evaluations, 'evaluations present');
    assert.ok(Array.isArray(result.evaluations), 'evaluations is array');
    assert.ok(result.summary, 'summary present');
    assert.equal(typeof result.summary.total, 'number', 'summary.total is number');
    assert.equal(typeof result.summary.evaluated, 'number', 'summary.evaluated is number');
    assert.equal(typeof result.summary.skipped, 'number', 'summary.skipped is number');
    assert.equal(typeof result.summary.avgDelta, 'number', 'summary.avgDelta is number');
    assert.ok(typeof result.report === 'string', 'report is string');
    assert.equal(result.filePath, testFile, 'filePath matches input');

    // Verify individual evaluation structure
    for (const ev of result.evaluations) {
      assert.ok(typeof ev.name === 'string', 'evaluation has name');
      assert.ok(typeof ev.type === 'string', 'evaluation has type');
      assert.ok(typeof ev.originalMaturity === 'number', 'evaluation has originalMaturity');
      assert.ok(typeof ev.skipped === 'boolean', 'evaluation has skipped flag');
    }
  });

  // ── AC: Logger name consistency ───────────────────────────────────────

  it('all notifications use "evaluateMap" as logger name', async () => {
    setVerbose(true);
    await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: false,
    });

    // Filter to only evaluateMap logger (nested estimateEvolution calls have their own logger)
    const evalMapMsgs = cap.messages.filter(m => m.params.logger === 'evaluateMap');
    assert.ok(evalMapMsgs.length >= 2, `Expected at least 2 evaluateMap messages, got ${evalMapMsgs.length}`);

    // Verify no mixed loggers within evaluateMap-level notifications
    for (const msg of evalMapMsgs) {
      assert.equal(
        msg.params.logger, 'evaluateMap',
        `Logger should be "evaluateMap", got "${msg.params.logger}"`
      );
    }
  });

  // ── AC: JSON-RPC 2.0 notification format ──────────────────────────────

  it('all notifications follow JSON-RPC 2.0 notification format', async () => {
    setVerbose(true);
    await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: false,
    });

    assert.ok(cap.messages.length > 0, 'Should have captured notifications');

    for (const msg of cap.messages) {
      assert.equal(msg.jsonrpc, '2.0', 'Must be JSON-RPC 2.0');
      assert.equal(msg.method, 'notifications/message', 'Method must be notifications/message');
      assert.ok(!('id' in msg), 'Notifications must not have an id');
      assert.ok(msg.params, 'Must have params');
      assert.ok(['debug', 'info', 'warning', 'error'].includes(msg.params.level), `Valid level: ${msg.params.level}`);
      assert.ok(typeof msg.params.logger === 'string', 'Logger is string');
      assert.ok(typeof msg.params.data === 'string', 'Data is string');
    }
  });

  // ── AC: Summary includes correct counts ────────────────────────────────

  it('info end message includes component count and duration', async () => {
    setVerbose(false);
    const result = await evaluateMapFile(testFile, {
      strategy: 's-curve',
      updateFile: false,
    });

    const infoMsgs = byLevel(cap.messages, 'info');
    const endMsg = infoMsgs[infoMsgs.length - 1].params.data;

    // Should include component count
    assert.ok(/\d+/.test(endMsg), `End message should include count/duration: ${endMsg}`);
    // Should include duration in ms
    assert.ok(endMsg.includes('ms'), `End message should mention milliseconds: ${endMsg}`);
  });
});
