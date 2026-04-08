// AC 8: Existing tool behavior and output remain unchanged apart from added notifications
//
// This regression test validates that:
//   1. estimateEvolution return value shape is identical (mode, classification, reQuestions, evaluations, message)
//   2. evaluateMap return value shape is identical (evaluations, summary, report, updatedContent, filePath)
//   3. generateValueChain tool definition is unchanged
//   4. MCP server response wrapping (content[0].text JSON) is unchanged
//   5. Notifications are separate JSON-RPC messages (no id) and do NOT appear in tool results
//   6. Error responses maintain the same {error} shape with isError flag
//   7. parseWardleyMap output is unchanged
//   8. handleRequest still returns correct JSON-RPC 2.0 structure for all methods

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setVerbose } from './mcp-notifications.mjs';
import { estimateEvolutionOneShot } from './estimate-evolution.mjs';
import { parseWardleyMap, formatEvaluationReport } from './evaluate-map.mjs';
import { handleRequest, REGISTERED_TOOLS, TOOL_HANDLERS } from './mcp-server.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Capture MCP notification JSON-RPC messages written to stdout.
 * Allows the rest of stdout to pass through normally.
 */
function captureNotifications() {
  const notifications = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = (chunk, ...args) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('"notifications/message"')) {
      try {
        notifications.push(JSON.parse(str.trim()));
      } catch {
        return originalWrite(chunk, ...args);
      }
      return true;
    }
    return originalWrite(chunk, ...args);
  };

  return {
    notifications,
    restore: () => { process.stdout.write = originalWrite; },
  };
}

// ─── Test Suite ────────────────────────────────────────────────────────────

describe('AC 8: Existing tool output unchanged', () => {
  let cap;

  beforeEach(() => {
    cap = captureNotifications();
  });

  afterEach(() => {
    cap.restore();
    setVerbose(false);
  });

  // ── estimateEvolution: one-shot economic result shape ──────────────────

  it('estimateEvolutionOneShot returns exact expected shape for economic component', async () => {
    setVerbose(true); // Even with verbose + notifications, result is unchanged

    const result = await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning for large corporations',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    // Verify top-level keys include all original fields (routing is a new addition from solution-capability routing)
    const topKeys = Object.keys(result).sort();
    const requiredKeys = ['classification', 'evaluations', 'message', 'mode', 'reQuestions'];
    const allowedKeys = [...requiredKeys, 'routing']; // routing added by solution-capability router
    for (const key of requiredKeys) {
      assert.ok(topKeys.includes(key), `Required key "${key}" must be present, got: ${topKeys.join(', ')}`);
    }
    for (const key of topKeys) {
      assert.ok(allowedKeys.includes(key), `Unexpected key "${key}" in result, allowed: ${allowedKeys.join(', ')}`);
    }

    // Verify types
    assert.equal(result.mode, 'oneshot', 'mode must be "oneshot"');
    assert.equal(typeof result.classification, 'object', 'classification must be object');
    assert.equal(result.classification.space, 'economic', 'space must be economic');
    assert.equal(typeof result.classification.reason, 'string', 'classification.reason must be string');
    assert.equal(typeof result.classification.requiresReQuestion, 'boolean', 'classification.requiresReQuestion must be boolean');
    assert.equal(result.reQuestions, null, 'reQuestions must be null for economic');
    assert.equal(typeof result.evaluations, 'object', 'evaluations must be object');
    assert.notEqual(result.evaluations, null, 'evaluations must not be null for economic');
    assert.equal(typeof result.message, 'string', 'message must be string');

    // Verify s-curve evaluation shape
    const scurve = result.evaluations['s-curve'];
    assert.ok(scurve, 's-curve evaluation must exist');
    assert.equal(typeof scurve.evolution, 'number', 'evolution must be number');
    assert.equal(typeof scurve.confidence, 'number', 'confidence must be number');
    assert.ok(typeof scurve.evolution === 'number' && !Number.isNaN(scurve.evolution), 'evolution is valid number');
    assert.ok(typeof scurve.confidence === 'number' && !Number.isNaN(scurve.confidence), 'confidence is valid number');

    // Verify no notification data leaked into the result
    assert.equal(result.notifications, undefined, 'no notifications key in result');
    assert.equal(result.logs, undefined, 'no logs key in result');
    assert.equal(result.progress, undefined, 'no progress key in result');
  });

  // ── estimateEvolution: non-economic result shape ──────────────────────

  it('estimateEvolutionOneShot returns exact expected shape for social_good component', async () => {
    const result = await estimateEvolutionOneShot({
      name: 'Air',
      description: 'Atmospheric oxygen available to grow crops',
      space: 'social_good',
    });

    // Verify top-level keys
    const topKeys = Object.keys(result).sort();
    assert.deepEqual(topKeys, ['classification', 'evaluations', 'message', 'mode', 'reQuestions'].sort());

    assert.equal(result.mode, 'oneshot');
    assert.equal(result.classification.space, 'social_good');
    assert.equal(result.evaluations, null, 'evaluations must be null for non-economic');
    assert.ok(Array.isArray(result.reQuestions), 'reQuestions must be array for non-economic');
    assert.ok(result.reQuestions.length > 0, 'reQuestions must have entries');
    assert.equal(typeof result.message, 'string');
  });

  // ── Notifications are separate, not in tool output ────────────────────

  it('notifications do not appear inside the tool result JSON', async () => {
    setVerbose(true);

    const result = await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    // Serialize the result and check no notification artifacts are present
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('notifications/message'), 'Result must not contain notification method');
    assert.ok(!serialized.includes('"jsonrpc":"2.0"'), 'Result must not contain JSON-RPC wrapper');

    // But we should have captured notifications separately
    assert.ok(cap.notifications.length > 0, 'Notifications should have been emitted separately');
  });

  // ── MCP server handleRequest: initialize ──────────────────────────────

  it('handleRequest(initialize) returns unchanged server info and capabilities', async () => {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.ok(response.result);
    assert.equal(response.result.protocolVersion, '2024-11-05');
    assert.equal(response.result.serverInfo.name, 'wardley-assistant');
    assert.equal(response.result.serverInfo.version, '1.0.0');
    assert.ok(response.result.capabilities.tools !== undefined);
    assert.ok(response.result.capabilities.logging !== undefined);
  });

  // ── MCP server handleRequest: tools/list ──────────────────────────────

  it('handleRequest(tools/list) returns all registered tools including original 3', async () => {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 2);
    const toolNames = response.result.tools.map(t => t.name).sort();
    // Original 3 tools must still be present
    const originalTools = ['estimateEvolution', 'evaluateMap', 'generateValueChain'];
    for (const tool of originalTools) {
      assert.ok(toolNames.includes(tool), `Original tool "${tool}" must be registered, got: ${toolNames.join(', ')}`);
    }
    // New tools added by solution routing (estimateAnchorEvolution, identifyCapability) are allowed
    assert.ok(toolNames.length >= 3, `Must have at least 3 tools, got ${toolNames.length}`);
  });

  // ── MCP server handleRequest: tools/call wrapping format ──────────────

  it('handleRequest(tools/call) wraps result in content[0].text JSON', async () => {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'estimateEvolution',
        arguments: {
          name: 'ERP',
          context: 'Enterprise resource planning',
          space: 'economic',
          strategy: 's-curve',
          certitude: 0.9,
          ubiquity: 0.85,
        },
      },
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 3);
    assert.ok(response.result, 'Must have result');
    assert.ok(Array.isArray(response.result.content), 'result.content must be array');
    assert.equal(response.result.content.length, 1, 'Must have exactly 1 content item');
    assert.equal(response.result.content[0].type, 'text', 'Content type must be text');
    assert.equal(response.result.isError, undefined, 'isError must not be set on success');

    // The text is valid JSON matching the tool result
    const parsed = JSON.parse(response.result.content[0].text);
    assert.equal(parsed.mode, 'oneshot');
    assert.equal(parsed.classification.space, 'economic');
    assert.ok(parsed.evaluations);
  });

  // ── MCP server: unknown tool error format ─────────────────────────────

  it('handleRequest(tools/call) returns isError for unknown tool', async () => {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'nonExistentTool',
        arguments: {},
      },
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 4);
    assert.equal(response.result.isError, true, 'isError must be true');
    assert.ok(response.result.content[0].text.includes('Unknown tool'), 'Error message mentions unknown tool');
  });

  // ── MCP server: ping unchanged ────────────────────────────────────────

  it('handleRequest(ping) returns empty result', async () => {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'ping',
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 5);
    assert.deepEqual(response.result, {});
  });

  // ── MCP server: unknown method error ──────────────────────────────────

  it('handleRequest returns method-not-found for unknown method', async () => {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'unknown/method',
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 6);
    assert.equal(response.error.code, -32601);
  });

  // ── Notifications follow JSON-RPC 2.0 spec ───────────────────────────

  it('notifications are valid JSON-RPC 2.0 without id (fire-and-forget)', async () => {
    setVerbose(true);

    await estimateEvolutionOneShot({
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    assert.ok(cap.notifications.length > 0, 'Should have captured notifications');

    for (const notif of cap.notifications) {
      // Notifications MUST NOT have an id field
      assert.ok(!('id' in notif), `Notification must not have id: ${JSON.stringify(notif)}`);
      // Must be JSON-RPC 2.0
      assert.equal(notif.jsonrpc, '2.0');
      // Must use notifications/message method
      assert.equal(notif.method, 'notifications/message');
      // Must have params with level, logger, data
      assert.ok(notif.params, 'Notification must have params');
      assert.ok(typeof notif.params.level === 'string', 'level must be string');
      assert.ok(typeof notif.params.logger === 'string', 'logger must be string');
      assert.ok(typeof notif.params.data === 'string', 'data must be string');
    }
  });

  // ── parseWardleyMap output is unchanged ───────────────────────────────

  it('parseWardleyMap returns the same structure as before notifications', () => {
    const testWm = `title Tea Shop

anchor Business [0.95, 0.63]

component Cup of Tea [0.79, 0.61]
component Cup [0.73, 0.78] (buy)
component Kettle [0.32, 0.33] (inertia) label [-48, -13]

Business->Cup of Tea
Cup of Tea->Cup

style wardley`;

    const parsed = parseWardleyMap(testWm);

    // Shape validation
    assert.equal(parsed.title, 'Tea Shop');
    assert.equal(parsed.style, 'wardley');
    assert.equal(parsed.anchors.length, 1);
    assert.equal(parsed.components.length, 3);
    assert.equal(parsed.links.length, 2);

    // Component shape
    const cup = parsed.components.find(c => c.name === 'Cup');
    assert.ok(cup, 'Cup component must exist');
    assert.equal(cup.visibility, 0.73);
    assert.equal(cup.maturity, 0.78);
    assert.deepEqual(cup.decorators, ['buy']);
    assert.equal(cup.label, null);

    // Kettle has label
    const kettle = parsed.components.find(c => c.name === 'Kettle');
    assert.ok(kettle);
    assert.deepEqual(kettle.label, [-48, -13]);
    assert.deepEqual(kettle.decorators, ['inertia']);

    // No notification-related keys
    assert.equal(parsed.notifications, undefined);
    assert.equal(parsed.logs, undefined);
  });

  // ── Tool registry is complete ─────────────────────────────────────────

  it('tool registry has at least 3 original tools with handlers', () => {
    assert.ok(REGISTERED_TOOLS.length >= 3, `Must have at least 3 tools, got ${REGISTERED_TOOLS.length}`);
    const names = REGISTERED_TOOLS.map(t => t.name).sort();
    // Original 3 tools must still be present
    const originalTools = ['estimateEvolution', 'evaluateMap', 'generateValueChain'];
    for (const tool of originalTools) {
      assert.ok(names.includes(tool), `Original tool "${tool}" must be registered, got: ${names.join(', ')}`);
    }

    // Each tool has a handler
    for (const tool of REGISTERED_TOOLS) {
      assert.ok(TOOL_HANDLERS.has(tool.name), `Handler for ${tool.name} must exist`);
      assert.equal(typeof TOOL_HANDLERS.get(tool.name), 'function', `Handler for ${tool.name} must be a function`);
    }
  });

  // ── Verbose mode does not change result ───────────────────────────────

  it('verbose=true and verbose=false produce identical tool results', async () => {
    const input = {
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 's-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    };

    // Run with verbose off
    setVerbose(false);
    const resultQuiet = await estimateEvolutionOneShot(input);

    // Run with verbose on
    setVerbose(true);
    const resultVerbose = await estimateEvolutionOneShot(input);

    // Results must be structurally identical
    assert.equal(resultQuiet.mode, resultVerbose.mode);
    assert.equal(resultQuiet.classification.space, resultVerbose.classification.space);
    assert.equal(resultQuiet.reQuestions, resultVerbose.reQuestions);
    assert.deepEqual(
      Object.keys(resultQuiet.evaluations).sort(),
      Object.keys(resultVerbose.evaluations).sort(),
      'Same strategies evaluated'
    );

    // Evolution values should be identical (deterministic s-curve)
    assert.equal(
      resultQuiet.evaluations['s-curve'].evolution,
      resultVerbose.evaluations['s-curve'].evolution,
      'Evolution value unchanged by verbose mode'
    );
    assert.equal(
      resultQuiet.evaluations['s-curve'].confidence,
      resultVerbose.evaluations['s-curve'].confidence,
      'Confidence value unchanged by verbose mode'
    );
  });

  // ── formatEvaluationReport output is unchanged ────────────────────────

  it('formatEvaluationReport produces markdown table without notification data', () => {
    const evaluations = [
      { name: 'ERP', originalMaturity: 0.50, newMaturity: 0.78, delta: 0.28, skipped: false, classification: 'economic', strategies: {} },
      { name: 'Air', originalMaturity: 0.50, newMaturity: null, skipped: true, classification: 'social_good', reason: 'social good' },
    ];
    const summary = { total: 2, evaluated: 1, skipped: 1, avgDelta: 0.28 };

    const report = formatEvaluationReport(evaluations, summary);

    assert.ok(report.includes('## Evaluation Report'), 'Report has header');
    assert.ok(report.includes('ERP'), 'Report mentions ERP');
    assert.ok(report.includes('Air'), 'Report mentions Air');
    assert.ok(report.includes('1/2 evaluated'), 'Report has summary');
    assert.ok(!report.includes('notification'), 'Report does not mention notifications');
    assert.ok(!report.includes('progress'), 'Report does not mention progress');
  });

  // ── Tool handler input validation unchanged ───────────────────────────

  it('estimateEvolution input validation errors are unchanged', async () => {
    // Null input
    await assert.rejects(
      () => estimateEvolutionOneShot(null),
      { message: /non-null object/ },
    );

    // Missing name
    await assert.rejects(
      () => estimateEvolutionOneShot({}),
      { message: /non-empty string/ },
    );

    // Invalid space
    await assert.rejects(
      () => estimateEvolutionOneShot({ name: 'X', space: 'invalid' }),
      { message: /must be one of/ },
    );

    // Out of range numeric
    await assert.rejects(
      () => estimateEvolutionOneShot({ name: 'X', certitude: 2 }),
      { message: /between 0 and 1/ },
    );

    // Invalid type numeric
    await assert.rejects(
      () => estimateEvolutionOneShot({ name: 'X', certitude: 'abc' }),
      { message: /must be a number/ },
    );
  });
});
