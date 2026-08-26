#!/usr/bin/env node
// COMPOSITION ROOT — MCP over HTTP.
//
// This is the whole of what CH-23 inverted, and it is deliberately this short.
// The three things that used to be tangled inside `src/core/transport/` are
// each built by their own owner and met HERE, at the edge:
//
//   the MCP surface        → src/mcp/tool-registry.mts      (this layer)
//   the MCP costume        → src/mcp/{prompt,resource}-registry.mts (this layer)
//   the strategy catalogue → src/frameworks/registry-boot.mts (the frameworks)
//   the wire               → the transport's startHttpDaemon (knows neither)
//
// Nothing under src/core/ or the transport names a tool; nothing under the
// transport names a framework. Adding a delivery (a CLI, an in-process
// embedding, a different protocol) means writing another file like this one —
// not touching the kernel. CH-24 proved that: the costume (prompts +
// resources) is two more lines here and zero edits to the wire.

import { fileURLToPath } from "node:url";
import { startHttpDaemon } from "#transport/http-daemon.mjs";
import { buildStrategyRegistry } from "#frameworks/registry-boot.mjs";
import { buildMcpToolRegistry } from "./tool-registry.mjs";
import { buildMcpPromptRegistry } from "./prompt-registry.mjs";
import { buildMcpResourceRegistry } from "./resource-registry.mjs";

export async function main(): Promise<void> {
  // The same catalogue instance is handed to the daemon (boot report,
  // mcp_boot count) and to the resource surface, so `labre://methods`
  // describes the very registry this process will resolve against.
  const strategies = buildStrategyRegistry();
  await startHttpDaemon({
    tools: buildMcpToolRegistry(),
    prompts: buildMcpPromptRegistry(),
    resources: await buildMcpResourceRegistry({ strategies }),
    strategies,
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
