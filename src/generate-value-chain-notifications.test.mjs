// Validation test for generateValueChain MCP progress notifications
//
// Validates the same notification pattern as estimateEvolution and evaluateMap:
//   1. Info-level log at tool start and end (localized)
//   2. Debug-level log at intermediate steps (decomposition, progress, bestpick, summary, generation)
//   3. Language detection from description args
//   4. Verbose mode gating (debug suppressed when off)
//   5. Existing tool output remains unchanged
//   6. Logger name consistency ("generateValueChain")
//   7. JSON-RPC 2.0 notification format compliance
//
// Uses mock.module() to intercept LLM calls (Agent SDK) at import level,
// while keeping the real s-curve strategy for estimateEvolution (pure computation).

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mock LLM Decomposition ──────────────────────────────────────────────

// Canned value chain JSON that the LLM would return
const MOCK_VALUE_CHAIN = JSON.stringify({
  title: 'Tea Shop',
  anchor: { name: 'Customer', context: 'End consumer wanting hot beverages' },
  components: [
    { name: 'Cup of Tea', context: 'Hot tea served to customer', visibility: 0.79, dependsOn: ['Tea', 'Hot Water', 'Cup'] },
    { name: 'Cup', context: 'Ceramic drinking vessel', visibility: 0.73, dependsOn: [] },
    { name: 'Tea', context: 'Loose leaf or bagged tea', visibility: 0.63, dependsOn: [] },
    { name: 'Hot Water', context: 'Heated water for brewing', visibility: 0.52, dependsOn: ['Kettle'] },
    { name: 'Kettle', context: 'Electric heating appliance', visibility: 0.32, dependsOn: ['Power'] },
    { name: 'Power', context: 'Electrical utility supply', visibility: 0.11, dependsOn: [] },
  ],
});

// Mock the Agent SDK query function BEFORE any module that uses it is loaded
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: function mockQuery() {
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          result: MOCK_VALUE_CHAIN,
        };
      })();
    },
  },
});

// Now import modules that depend on the mocked SDK
const { setVerbose } = await import('./mcp-notifications.mjs');
const { generateValueChain } = await import('./generate-value-chain.mjs');

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Capture JSON-RPC notifications written to stdout during test execution.
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

/** Extract notification data (message text) from captured messages */
function dataTexts(messages) {
  return messages.map(m => m.params.data);
}

/** Filter messages by level */
function byLevel(messages, level) {
  return messages.filter(m => m.params.level === level);
}

// ─── generateValueChain Notification Validation Tests ────────────────────

describe('generateValueChain — progress notifications', () => {
  let cap;
  let outputDir;
  let createdFiles = [];

  beforeEach(() => {
    outputDir = join(tmpdir(), `wardley-vc-test-${Date.now()}`);
    createdFiles = [];
    cap = captureNotifications();
  });

  afterEach(async () => {
    cap.restore();
    setVerbose(false);

    // Cleanup created files
    for (const f of createdFiles) {
      try { await unlink(f); } catch { /* ignore */ }
    }
    try { await rmdir(outputDir); } catch { /* ignore */ }
  });

  // ── AC: Info-level start/end messages ─────────────────────────────────

  it('emits info-level log at start and end for value chain generation', async () => {
    setVerbose(false);
    const result = await generateValueChain('A tea shop serving hot beverages to customers', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    // Result should be valid
    assert.ok(result.wmContent, 'wmContent present');
    assert.ok(result.filePath, 'filePath present');
    assert.ok(result.components, 'components present');
    assert.ok(result.evaluations, 'evaluations present');

    // Filter to only generateValueChain logger
    const vcMsgs = cap.messages.filter(m => m.params.logger === 'generateValueChain');
    const infoMsgs = byLevel(vcMsgs, 'info');

    assert.ok(infoMsgs.length >= 2, `Expected at least 2 info messages, got ${infoMsgs.length}`);

    // First info: tool start
    const startMsg = infoMsgs[0].params.data;
    assert.ok(
      startMsg.includes('generateValueChain') || startMsg.includes('Starting') || startMsg.includes('Démarrage'),
      `Start message mentions tool: ${startMsg}`
    );

    // Last info: tool end with duration
    const endMsg = infoMsgs[infoMsgs.length - 1].params.data;
    assert.ok(/\d+/.test(endMsg), `End message includes duration: ${endMsg}`);
    assert.ok(endMsg.includes('ms'), `End message mentions milliseconds: ${endMsg}`);
  });

  // ── AC: Debug messages at intermediate steps ──────────────────────────

  it('emits debug-level logs for intermediate steps when verbose is on', async () => {
    setVerbose(true);
    const result = await generateValueChain('A tea shop serving hot beverages', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    const vcMsgs = cap.messages.filter(m => m.params.logger === 'generateValueChain');
    const debugMsgs = byLevel(vcMsgs, 'debug');

    assert.ok(debugMsgs.length >= 3, `Expected at least 3 debug messages, got ${debugMsgs.length}`);

    const debugTexts = dataTexts(debugMsgs);

    // Check decomposition step is logged
    const hasDecomposition = debugTexts.some(t =>
      t.toLowerCase().includes('decompos') || t.toLowerCase().includes('décompos')
    );
    assert.ok(hasDecomposition, `Debug should mention decomposition step. Got: ${debugTexts.join(' | ')}`);

    // Check per-component progress is logged (X/Y format)
    const hasProgress = debugTexts.some(t => /\d+\/\d+/.test(t));
    assert.ok(hasProgress, 'Debug should mention component progress (X/Y format)');

    // Check WM generation step
    const hasGeneration = debugTexts.some(t =>
      t.toLowerCase().includes('.wm') || t.toLowerCase().includes('generat') || t.toLowerCase().includes('génér')
    );
    assert.ok(hasGeneration, `Debug should mention WM generation step. Got: ${debugTexts.join(' | ')}`);
  });

  it('suppresses debug messages when verbose is off', async () => {
    setVerbose(false);
    const result = await generateValueChain('A tea shop serving hot beverages', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    const vcMsgs = cap.messages.filter(m => m.params.logger === 'generateValueChain');
    const debugMsgs = byLevel(vcMsgs, 'debug');
    assert.equal(debugMsgs.length, 0, 'Debug messages should be suppressed when verbose is off');
  });

  // ── AC: Language detection ────────────────────────────────────────────

  it('emits English-localized messages for English description', async () => {
    setVerbose(false);
    const result = await generateValueChain('A tea shop serving hot beverages to customers', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    const vcMsgs = cap.messages.filter(m => m.params.logger === 'generateValueChain');
    const infoMsgs = byLevel(vcMsgs, 'info');
    assert.ok(infoMsgs.length >= 2, 'Should have start + end info messages');

    const startMsg = infoMsgs[0].params.data;
    assert.ok(
      startMsg.includes('Starting') || startMsg.includes('generateValueChain'),
      `English start message expected: ${startMsg}`
    );
  });

  it('emits French-localized messages for French description', async () => {
    setVerbose(false);
    const result = await generateValueChain("Un salon de thé servant des boissons chaudes aux clients parisiens", {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    const vcMsgs = cap.messages.filter(m => m.params.logger === 'generateValueChain');
    const infoMsgs = byLevel(vcMsgs, 'info');
    assert.ok(infoMsgs.length >= 2, 'Should have start + end info messages');

    const startMsg = infoMsgs[0].params.data;
    assert.ok(
      startMsg.includes('Démarrage') || startMsg.includes('generateValueChain'),
      `French start message expected: ${startMsg}`
    );
  });

  // ── AC: Existing tool output unchanged ────────────────────────────────

  it('does not alter the returned result structure', async () => {
    setVerbose(true);
    const result = await generateValueChain('A tea shop serving hot beverages', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    assert.ok(typeof result.wmContent === 'string', 'wmContent is string');
    assert.ok(result.wmContent.includes('title'), 'wmContent includes title');
    assert.ok(result.wmContent.includes('style wardley'), 'wmContent includes style');
    assert.ok(typeof result.filePath === 'string', 'filePath is string');
    assert.ok(result.filePath.endsWith('.wm'), 'filePath ends with .wm');
    assert.ok(Array.isArray(result.components), 'components is array');
    assert.ok(result.components.length > 0, 'components is non-empty');
    assert.ok(typeof result.evaluations === 'object', 'evaluations is object');

    for (const comp of result.components) {
      assert.ok(typeof comp.name === 'string', 'component has name');
      assert.ok(typeof comp.visibility === 'number', 'component has visibility');
    }
  });

  // ── AC: Logger name consistency ───────────────────────────────────────

  it('all generateValueChain notifications use "generateValueChain" as logger name', async () => {
    setVerbose(true);
    const result = await generateValueChain('A tea shop serving hot beverages', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    const vcMsgs = cap.messages.filter(m => m.params.logger === 'generateValueChain');
    assert.ok(vcMsgs.length >= 2, `Expected at least 2 generateValueChain messages, got ${vcMsgs.length}`);

    for (const msg of vcMsgs) {
      assert.equal(msg.params.logger, 'generateValueChain');
    }
  });

  // ── AC: JSON-RPC 2.0 notification format ──────────────────────────────

  it('all notifications follow JSON-RPC 2.0 notification format', async () => {
    setVerbose(true);
    const result = await generateValueChain('A tea shop serving hot beverages', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

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

  // ── AC: Evaluation summary in debug ───────────────────────────────────

  it('emits evaluation summary with counts in debug', async () => {
    setVerbose(true);
    const result = await generateValueChain('A tea shop serving hot beverages', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    const vcMsgs = cap.messages.filter(m => m.params.logger === 'generateValueChain');
    const debugMsgs = byLevel(vcMsgs, 'debug');
    const debugTexts = dataTexts(debugMsgs);

    const hasSummary = debugTexts.some(t =>
      /\d+/.test(t) && (t.toLowerCase().includes('evaluat') || t.toLowerCase().includes('summary') || t.toLowerCase().includes('évaluat'))
    );
    assert.ok(hasSummary, `Debug should include evaluation summary. Got: ${debugTexts.join(' | ')}`);
  });

  // ── AC: Nested estimateEvolution notifications are separate ────────────

  it('nested estimateEvolution calls emit their own notifications with correct logger', async () => {
    setVerbose(true);
    const result = await generateValueChain('A tea shop serving hot beverages', {
      strategy: 's-curve',
      outputDir,
    });

    createdFiles.push(result.filePath);

    const loggers = new Set(cap.messages.map(m => m.params.logger));
    assert.ok(loggers.has('generateValueChain'), 'Should have generateValueChain logger');
    assert.ok(loggers.has('estimateEvolution'), 'Should have estimateEvolution logger from nested calls');
  });
});
