// Daemon entrypoint for labre-mcp HTTP transport (ARCH-14).
// Boots the HTTP server on the configured port AND the strategy registry
// (ARCH-03). The strategy registry is populated by importing each
// framework's `registry.mts`, which calls `registerXxxStrategies(reg)`.
// MCP tool handlers consume this registry via the recipe runner to
// resolve methodIds at call time.

import { fileURLToPath } from "node:url";
import type { ToolRegistry } from "./mcp-handler.mjs";
import { startHttpServer } from "./http-server.mjs";
import { registerBootHealthChecks } from "./boot-health-checks.mjs";
import { runAllHealthChecks } from "#lib/degradation/index.mjs";

// Re-export so existing callers (tests, downstream tooling) can keep
// importing `buildStrategyRegistry` / `buildBootRegistry` from this module
// without churn. The tool registry is now built in the transport-agnostic
// boot-tool-registry module, shared with the stdio entrypoint.
export { buildStrategyRegistry } from "./strategy-registry-boot.mjs";
export { buildBootRegistry } from "./boot-tool-registry.mjs";
import { buildStrategyRegistry } from "./strategy-registry-boot.mjs";
import { buildBootRegistry } from "./boot-tool-registry.mjs";

const DEFAULT_PORT = 6767;

function readPort(): number {
  const raw = process.env.LABRE_HTTP_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid LABRE_HTTP_PORT: "${raw}" (expected integer 1-65535)`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const port = readPort();
  const tools: ToolRegistry = buildBootRegistry();
  const strategies = buildStrategyRegistry();

  const server = await startHttpServer({ port, tools });

  process.stderr.write(
    `[labre-mcp] HTTP server listening on http://127.0.0.1:${server.port} (POST /mcp)\n`,
  );
  process.stderr.write(
    `[labre-mcp] Tools registered: ${tools.list().map((t) => t.name).join(", ") || "(none)"}\n`,
  );
  process.stderr.write(
    `[labre-mcp] Strategies registered (${strategies.size()}):\n${strategies.list().map((id) => `  - ${id}`).join("\n")}\n`,
  );

  // Boot health checks (config/env presence only — no network). Never blocks boot.
  registerBootHealthChecks();
  const healthEvents = await runAllHealthChecks();
  if (healthEvents.length === 0) {
    process.stderr.write("[labre-mcp] Health checks: all dependencies ready\n");
  } else {
    process.stderr.write(
      `[labre-mcp] Health checks — ${healthEvents.length} dependency(ies) degraded:\n${healthEvents
        .map((e) => `  - ${e.source}: ${e.reason}`)
        .join("\n")}\n`,
    );
  }

  const shutdown = async (signal: string) => {
    process.stderr.write(`[labre-mcp] Received ${signal}, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
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
