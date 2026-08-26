#!/usr/bin/env node
// COMPOSITION ROOT — MCP over stdio. The `bin` of the published package.
//
// Same three-way meeting as labre-daemon.mts (see its header), over the other
// wire: Claude Code / the Agent SDK spawn this file directly
// (`{ "command": "npx", "args": ["-y", "labre-mcp"] }`).
//
// Protocol invariant: stdout carries ONLY MCP messages. Everything this file
// or the server below prints goes to stderr.

import { fileURLToPath } from "node:url";
import { startStdioServer } from "#transport/stdio-server.mjs";
import { buildStrategyRegistry } from "#frameworks/registry-boot.mjs";
import { buildMcpToolRegistry } from "./tool-registry.mjs";

export async function main(): Promise<void> {
  await startStdioServer({
    tools: buildMcpToolRegistry(),
    strategies: buildStrategyRegistry(),
  });
}

// Only run when executed as a script (not when imported by tests).
const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[labre-mcp] Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
