// Focused tests for the MCP server dispatch wrapping behavior introduced
// alongside the degradation framework. Verifies that tools/call:
//   - merges `degraded` + `degradationEvents` as siblings to the handler
//     payload (backward-compatible with the previous shape)
//   - propagates the per-invocation collector to handlers that opt in
//     by accepting a 2nd parameter
//
// These tests inject a synthetic handler via TOOL_HANDLERS — no LLM calls,
// no network, no BigQuery.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, TOOL_HANDLERS } from './mcp-server.mjs';
import type { JsonRpcSuccessResponse } from '../types/mcp.mjs';
import type { DegradationCollector } from '../lib/degradation/index.mjs';

const FAKE_TOOL = '__test_dispatch_tool';

function silenceStdout(): () => void {
  const original = process.stdout.write.bind(process.stdout);
  // any: monkey-patching stdout to swallow notifications during the test
  (process.stdout as any).write = (chunk: any, ..._args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('"notifications/')) return true;
    return original(chunk, ..._args);
  };
  return () => { (process.stdout as any).write = original; };
}

interface ContentResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function parseToolResult(resp: unknown): Record<string, unknown> {
  const success = resp as JsonRpcSuccessResponse<ContentResult>;
  return JSON.parse(success.result.content[0].text);
}

describe('mcp-server dispatch — Degradable envelope merging', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = silenceStdout();
  });

  afterEach(() => {
    restore();
    TOOL_HANDLERS.delete(FAKE_TOOL);
  });

  it('merges degraded:false + empty events into a normal object payload', async () => {
    TOOL_HANDLERS.set(FAKE_TOOL, async () => ({ score: 0.7, label: 'ok' }));

    const resp = await handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: FAKE_TOOL, arguments: {} },
    });

    const parsed = parseToolResult(resp);
    assert.equal(parsed.score, 0.7);
    assert.equal(parsed.label, 'ok');
    assert.equal(parsed.degraded, false);
    assert.deepEqual(parsed.degradationEvents, []);
  });

  it('handler that records on the collector flips degraded:true', async () => {
    TOOL_HANDLERS.set(FAKE_TOOL, async (_args, collector) => {
      const c = collector as DegradationCollector;
      c.record({ source: 'fake', reason: 'simulated', severity: 'warning', recoverable: true });
      return { value: 1 };
    });

    const resp = await handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: FAKE_TOOL, arguments: {} },
    });

    const parsed = parseToolResult(resp);
    assert.equal(parsed.value, 1);
    assert.equal(parsed.degraded, true);
    const events = parsed.degradationEvents as Array<{ source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'fake');
  });

  it('handler that ignores the collector still gets a Degradable envelope', async () => {
    // Legacy-style handler — only consumes args, ignores 2nd parameter.
    TOOL_HANDLERS.set(FAKE_TOOL, async (args) => ({ echoed: args }));

    const resp = await handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: FAKE_TOOL, arguments: { foo: 'bar' } },
    });

    const parsed = parseToolResult(resp);
    assert.deepEqual(parsed.echoed, { foo: 'bar' });
    assert.equal(parsed.degraded, false);
    assert.deepEqual(parsed.degradationEvents, []);
  });

  it('non-object handler results fall back to the explicit envelope shape', async () => {
    TOOL_HANDLERS.set(FAKE_TOOL, async () => 'just a string');

    const resp = await handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: FAKE_TOOL, arguments: {} },
    });

    const parsed = parseToolResult(resp);
    assert.equal(parsed.result, 'just a string');
    assert.equal(parsed.degraded, false);
    assert.deepEqual(parsed.degradationEvents, []);
  });

  it('handler exceptions still produce isError:true with the {error} shape', async () => {
    TOOL_HANDLERS.set(FAKE_TOOL, async () => { throw new Error('synthetic failure'); });

    const resp = await handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: FAKE_TOOL, arguments: {} },
    });

    const success = resp as JsonRpcSuccessResponse<ContentResult>;
    assert.equal(success.result.isError, true);
    const parsed = JSON.parse(success.result.content[0].text);
    assert.equal(parsed.error, 'synthetic failure');
  });

  it('unknown tool still returns isError without the Degradable envelope', async () => {
    const resp = await handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'non-existent-tool', arguments: {} },
    });

    const success = resp as JsonRpcSuccessResponse<ContentResult>;
    assert.equal(success.result.isError, true);
  });
});
