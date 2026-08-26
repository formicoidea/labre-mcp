#!/usr/bin/env node
// COMPOSITION ROOT — MCP over HTTP.
//
// This is the whole of what CH-23 inverted, and it is deliberately this short.
// The three things that used to be tangled inside `src/core/transport/` are
// each built by their own owner and met HERE, at the edge:
//
//   the MCP surface        → src/mcp/tool-registry.mts      (this layer)
//   the strategy catalogue → src/frameworks/registry-boot.mts (the frameworks)
//   the wire               → the transport's startHttpDaemon (knows neither)
//
// Nothing under src/core/ or the transport names a tool; nothing under the
// transport names a framework. Adding a delivery (a CLI, an in-process
// embedding, a different protocol) means writing another file like this one —
// not touching the kernel.

import { fileURLToPath } from "node:url";
import { startHttpDaemon } from "#core/transport/http-daemon.mjs";
import { buildStrategyRegistry } from "#frameworks/registry-boot.mjs";
import { buildMcpToolRegistry } from "./tool-registry.mjs";

export async function main(): Promise<void> {
  await startHttpDaemon({
    tools: buildMcpToolRegistry(),
    strategies: buildStrategyRegistry(),
  });
}

// Only run when executed as a script (not when imported by tests).
// fileURLToPath handles Windows/Unix path-encoding differences uniformly.
const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[labre-mcp] Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
