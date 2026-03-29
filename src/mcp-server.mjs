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
//   node src/mcp-server.mjs
//
// Protocol: JSON-RPC 2.0 over stdin/stdout (newline-delimited)
// Spec: https://modelcontextprotocol.io/specification

import { createInterface } from 'node:readline';
import { ESTIMATE_EVOLUTION_TOOL, handleEstimateEvolution } from './mcp-tool.mjs';
import { GENERATE_VALUE_CHAIN_TOOL, handleGenerateValueChain } from './generate-value-chain.mjs';
import { EVALUATE_MAP_TOOL, handleEvaluateMap } from './evaluate-map.mjs';

// ─── Tool Registry ──────────────────────────────────────────────────────────

/** All registered MCP tools. Add new tools here if needed. */
const REGISTERED_TOOLS = [
  ESTIMATE_EVOLUTION_TOOL,
  GENERATE_VALUE_CHAIN_TOOL,
  EVALUATE_MAP_TOOL,
];

/** Map of tool name → handler for fast dispatch */
const TOOL_HANDLERS = new Map([
  [ESTIMATE_EVOLUTION_TOOL.name, handleEstimateEvolution],
  [GENERATE_VALUE_CHAIN_TOOL.name, handleGenerateValueChain],
  [EVALUATE_MAP_TOOL.name, handleEvaluateMap],
]);

// ─── MCP Server Implementation ─────────────────────────────────────────────

const SERVER_INFO = {
  name: 'wardley-assistant',
  version: '1.0.0',
};

const SERVER_CAPABILITIES = {
  tools: {},
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

      try {
        const result = await handler(params?.arguments ?? {});
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
