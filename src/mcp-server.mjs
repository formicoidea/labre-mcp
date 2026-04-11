#!/usr/bin/env node

// Thin re-export — the real implementation lives in src/mcp/mcp-server.mjs.
// This file exists at src/ root so that external references
// (e.g. .mcp.json "args": ["src/mcp-server.mjs"]) keep working.

export { startServer, REGISTERED_TOOLS, TOOL_HANDLERS, handleRequest } from './mcp/mcp-server.mjs';

// Auto-start when run directly
import { startServer } from './mcp/mcp-server.mjs';

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  startServer();
}
