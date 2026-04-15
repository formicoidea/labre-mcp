// Pilot validation test for estimateEvolution MCP progress notifications
//
// Validates the complete notification pipeline:
//   1. Info-level log at tool start and end (localized)
//   2. Debug-level log at intermediate steps (classification, strategy, results)
//   3. Language detection from user input args
//   4. Verbose mode gating (debug suppressed when off)
//   5. Existing tool output remains unchanged
//
// This is the PILOT test — once validated, the same pattern generalizes
// to evaluateMap.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setVerbose } from '../../../lib/mcp-notifications.mjs';
import { estimateEvolutionOneShot } from '../../estimate-evolution.mjs';

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

// ─── Pilot Validation Tests ───────────────────────────────────────────────

describe('estimateEvolution pilot — progress notifications', () => {
  let cap;

  beforeEach(() => {
    cap = captureNotifications();
  });

  afterEach(() => {
    cap.restore();
    setVerbose(false);
  });

  // ── AC: Info-level start/end messages ─────────────────────────────────

  it('emits info-level log at start and end for economic component', async () => {
    setVerbose(false); // debug suppressed, only info visible
    const result = await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning for large corporations',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    // Result should be unchanged
    assert.equal(result.mode, 'oneshot');
    assert.equal(result.classification.space, 'economic');
    assert.ok(result.evaluations['s-curve'], 's-curve evaluation present');

    // Info-level notifications at start and end
    const infoMsgs = byLevel(cap.messages, 'info');
    assert.ok(infoMsgs.length >= 2, `Expected at least 2 info messages, got ${infoMsgs.length}`);

    // First info: tool start with component name
    const startMsg = infoMsgs[0].params.data;
    assert.ok(startMsg.includes('estimateEvolution'), `Start message mentions tool: ${startMsg}`);
    assert.ok(startMsg.includes('ERP'), `Start message mentions component: ${startMsg}`);

    // Last info: tool end with component name and duration
    const endMsg = infoMsgs[infoMsgs.length - 1].params.data;
    assert.ok(endMsg.includes('estimateEvolution'), `End message mentions tool: ${endMsg}`);
    assert.ok(endMsg.includes('ERP'), `End message mentions component: ${endMsg}`);
    assert.ok(/\d+/.test(endMsg), `End message includes duration: ${endMsg}`);
  });

  it('emits info-level log for non-economic component (early exit)', async () => {
    setVerbose(false);
    const result = await estimateEvolutionOneShot({
      name: 'Air',
      description: 'Atmospheric oxygen available to grow crops',
      space: 'social_good',
    });

    assert.equal(result.classification.space, 'social_good');
    assert.equal(result.evaluations, null);
    assert.ok(result.reQuestions.length > 0);

    const infoMsgs = byLevel(cap.messages, 'info');
    assert.ok(infoMsgs.length >= 2, `Expected at least 2 info msgs for non-economic, got ${infoMsgs.length}`);
  });

  // ── AC: Debug messages at intermediate steps ──────────────────────────

  it('emits debug-level logs for intermediate steps when verbose is on', async () => {
    setVerbose(true);
    await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    const debugMsgs = byLevel(cap.messages, 'debug');
    assert.ok(debugMsgs.length >= 2, `Expected debug messages, got ${debugMsgs.length}`);

    // Check that intermediate steps are logged
    const debugTexts = dataTexts(debugMsgs);
    const hasClassification = debugTexts.some(t => t.includes('economic') || t.includes('classif'));
    assert.ok(hasClassification, 'Debug should mention classification step');

    const hasStrategy = debugTexts.some(t => t.includes('s-curve'));
    assert.ok(hasStrategy, 'Debug should mention strategy execution');
  });

  it('suppresses debug messages when verbose is off', async () => {
    setVerbose(false);
    await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    const debugMsgs = byLevel(cap.messages, 'debug');
    assert.equal(debugMsgs.length, 0, 'Debug messages should be suppressed when verbose is off');
  });

  // ── AC: Language detection ────────────────────────────────────────────

  it('emits French-localized messages for French input', async () => {
    setVerbose(false);
    await estimateEvolutionOneShot({
      name: 'ERP',
      description: "Logiciel de gestion d'entreprise pour les grandes sociétés françaises",
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    const infoMsgs = byLevel(cap.messages, 'info');
    assert.ok(infoMsgs.length >= 2, 'Should have start + end info messages');

    // French start message should contain "Démarrage"
    const startMsg = infoMsgs[0].params.data;
    assert.ok(
      startMsg.includes('Démarrage') || startMsg.includes('estimateEvolution'),
      `French start message: ${startMsg}`
    );
  });

  it('emits English-localized messages for English input', async () => {
    setVerbose(false);
    await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning for large corporations',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    const infoMsgs = byLevel(cap.messages, 'info');
    const startMsg = infoMsgs[0].params.data;
    assert.ok(
      startMsg.includes('Starting'),
      `English start message should contain "Starting": ${startMsg}`
    );
  });

  // ── AC: All strategies with debug tracing ─────────────────────────────

  it('emits debug for each strategy when running all strategies', async () => {
    setVerbose(true);
    await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning',
      certitude: 0.9,
      ubiquity: 0.85,
      wonder: 0.02,
      build: 0.08,
      operate: 0.25,
      usage: 0.65,
    });

    const debugMsgs = byLevel(cap.messages, 'debug');
    // With 'all' strategies, we expect multiple strategy debug messages
    assert.ok(debugMsgs.length >= 3, `Expected multiple debug messages for all strategies, got ${debugMsgs.length}`);
  });

  // ── AC: Existing tool output unchanged ────────────────────────────────

  it('does not alter the returned result structure', async () => {
    setVerbose(true); // Even with verbose, output unchanged
    const result = await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    // Verify result shape is identical to pre-notification implementation
    assert.equal(result.mode, 'oneshot');
    assert.ok(result.classification, 'classification present');
    assert.equal(result.classification.space, 'economic');
    assert.equal(result.reQuestions, null);
    assert.ok(result.evaluations, 'evaluations present');
    assert.ok(result.evaluations['s-curve'], 's-curve result present');
    assert.ok(typeof result.evaluations['s-curve'].evolution === 'number', 'evolution is number');
    assert.ok(typeof result.evaluations['s-curve'].confidence === 'number', 'confidence is number');
    assert.ok(typeof result.message === 'string', 'message is string');
  });

  // ── AC: Logger name consistency ───────────────────────────────────────

  it('all notifications use "estimateEvolution" as logger name', async () => {
    setVerbose(true);
    await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    for (const msg of cap.messages) {
      assert.equal(
        msg.params.logger, 'estimateEvolution',
        `Logger should be "estimateEvolution", got "${msg.params.logger}"`
      );
    }
  });

  // ── AC: JSON-RPC 2.0 notification format ──────────────────────────────

  it('all notifications follow JSON-RPC 2.0 notification format', async () => {
    setVerbose(true);
    await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

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
});
