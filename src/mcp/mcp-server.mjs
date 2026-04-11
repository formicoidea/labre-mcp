#!/usr/bin/env node

// Guard: prevent recursive MCP server spawning.
// When the server spawns a Claude Code agent (via Agent SDK), the child process
// inherits this env var. If that child's MCP config tries to spawn another
// wardley-assistant server, the nested instance exits cleanly.
if (process.env._WARDLEY_NESTED) {
  process.stderr.write('[wardley-assistant] Nested MCP server detected — exiting cleanly\n');
  process.exit(0);
}
process.env._WARDLEY_NESTED = '1';

// MCP Server for WardleyAssistant
//
// Implements the Model Context Protocol (MCP) over stdio using JSON-RPC 2.0.
// Registers the estimateEvolution tool and routes tool/call requests to its handler.
//
// Usage:
//   node src/mcp/mcp-server.mjs
//
// Protocol: JSON-RPC 2.0 over stdin/stdout (newline-delimited)
// Spec: https://modelcontextprotocol.io/specification

import { createInterface } from 'node:readline';
import { ESTIMATE_EVOLUTION_TOOL, handleEstimateEvolution } from './mcp-tool.mjs';
import { GENERATE_VALUE_CHAIN_TOOL, handleGenerateValueChain } from '../tools/generate-value-chain.mjs';
import { EVALUATE_MAP_TOOL, handleEvaluateMap } from '../tools/evaluate-map.mjs';
import { IDENTIFY_CAPABILITY_TOOL, handleIdentifyCapability } from '../tools/identify-capability.mjs';
import { ESTIMATE_ANCHOR_EVOLUTION_TOOL, handleEstimateAnchorEvolution } from '../evolution/estimate-anchor-evolution.mjs';
import { logInfo, logError } from '../lib/mcp-notifications.mjs';
import { classifyAndLogLLMError, classifyLLMError } from '../lib/llm/llm-error-handler.mjs';

// ─── Tool Registry ──────────────────────────────────────────────────────────

/** All registered MCP tools. Add new tools here if needed. */
const REGISTERED_TOOLS = [
  ESTIMATE_EVOLUTION_TOOL,
  GENERATE_VALUE_CHAIN_TOOL,
  EVALUATE_MAP_TOOL,
  IDENTIFY_CAPABILITY_TOOL,
  ESTIMATE_ANCHOR_EVOLUTION_TOOL,
];

/** Map of tool name → handler for fast dispatch */
const TOOL_HANDLERS = new Map([
  [ESTIMATE_EVOLUTION_TOOL.name, handleEstimateEvolution],
  [GENERATE_VALUE_CHAIN_TOOL.name, handleGenerateValueChain],
  [EVALUATE_MAP_TOOL.name, handleEvaluateMap],
  [IDENTIFY_CAPABILITY_TOOL.name, handleIdentifyCapability],
  [ESTIMATE_ANCHOR_EVOLUTION_TOOL.name, handleEstimateAnchorEvolution],
]);

// ─── MCP Server Implementation ─────────────────────────────────────────────

const SERVER_INFO = {
  name: 'wardley-assistant',
  version: '1.0.0',
};

const SERVER_CAPABILITIES = {
  tools: {},
  logging: {},
  experimental: {
    'claude/channel': {},
  },
};

/**
 * Route an incoming JSON-RPC request to the appropriate handler.
 *
 * Supported methods:
 *   - initialize          → server info + capabilities
 *   - tools/list          → list all registered tools
 *   - tools/call          → dispatch to tool handler by name
 *   - notifications/initialized → acknowledge (no response)
 *   - ping                → pong
 *
 * @param {Object} request - JSON-RPC 2.0 request
 * @returns {Promise<Object|null>} JSON-RPC 2.0 response, or null for notifications
 */
async function handleRequest(request) {
  const { id, method, params } = request;

  // Notifications (no id) — no response expected
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    // ── Initialize handshake ──────────────────────────────────────────
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: SERVER_CAPABILITIES,
          instructions: 'Progress notifications arrive as <channel source="wardley-assistant" level="..." tool="...">. They are one-way status updates showing tool execution progress. Display them to the user as real-time progress indicators. No reply expected.',
        },
      };

    // ── Ping/pong ────────────────────────────────────────────────────
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    // ── List registered tools ────────────────────────────────────────
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: REGISTERED_TOOLS,
        },
      };

    // ── Call a tool ──────────────────────────────────────────────────
    case 'tools/call': {
      const toolName = params?.name;
      const handler = TOOL_HANDLERS.get(toolName);

      if (!handler) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Unknown tool: "${toolName}". Available: ${REGISTERED_TOOLS.map(t => t.name).join(', ')}`,
                }),
              },
            ],
            isError: true,
          },
        };
      }

      // Build a concise description of the invocation for log messages
      const toolArgs = params?.arguments ?? {};
      const toolSubject = toolArgs.name || toolArgs.filePath || toolArgs.description?.slice(0, 60) || '';
      const startMsg = toolSubject
        ? `Starting ${toolName} for "${toolSubject}"...`
        : `Starting ${toolName}...`;

      // Info-level: tool invocation start
      logInfo(toolName, startMsg);

      const startTime = Date.now();

      try {
        const result = await handler(toolArgs);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Info-level: tool invocation end (success)
        const endMsg = toolSubject
          ? `${toolName} completed for "${toolSubject}" in ${elapsed}s`
          : `${toolName} completed in ${elapsed}s`;
        logInfo(toolName, endMsg);

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      } catch (err) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Classify the error to determine if it's an LLM-specific issue
        const classified = classifyLLMError(err);
        const isLLMError = classified.type !== 'generic';

        // Error-level: tool invocation failure with specific error type
        const typeLabel = isLLMError ? ` [${classified.type}]` : '';
        const errMsg = toolSubject
          ? `${toolName} failed for "${toolSubject}" after ${elapsed}s${typeLabel}: ${err.message}`
          : `${toolName} failed after ${elapsed}s${typeLabel}: ${err.message}`;
        logError(toolName, errMsg);

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: err.message }, null, 2),
              },
            ],
            isError: true,
          },
        };
      }
    }

    // ── Unknown method ───────────────────────────────────────────────
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

// ─── Stdio Transport ────────────────────────────────────────────────────────

/**
 * Start the MCP server listening on stdin/stdout.
 * Reads newline-delimited JSON-RPC messages from stdin.
 * Writes JSON-RPC responses to stdout (one per line).
 */
export function startServer() {
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  // Track pending async handlers so we flush before exit
  const pending = [];

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
      return;
    }

    const task = handleRequest(request).then((response) => {
      // Notifications don't get responses
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    });
    pending.push(task);
  });

  rl.on('close', async () => {
    // Wait for all in-flight requests to complete before exiting
    await Promise.allSettled(pending);
    process.exit(0);
  });

  // Signal readiness to stderr (not stdout, to avoid protocol pollution)
  process.stderr.write(`[wardley-assistant] MCP server started. Tools: ${REGISTERED_TOOLS.map(t => t.name).join(', ')}\n`);
}

// ─── Exports for programmatic use ───────────────────────────────────────────

export { REGISTERED_TOOLS, TOOL_HANDLERS, handleRequest };

// ─── Auto-start when run directly ───────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  startServer();
}
