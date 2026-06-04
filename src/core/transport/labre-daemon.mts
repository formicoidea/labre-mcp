// Daemon entrypoint for labre-mcp HTTP transport (ARCH-14).
// Boots the HTTP server on the configured port AND the strategy registry
// (ARCH-03). The strategy registry is populated by importing each
// framework's `registry.mts`, which calls `registerXxxStrategies(reg)`.
// MCP tool handlers consume this registry via the recipe runner to
// resolve methodIds at call time.

import { fileURLToPath } from "node:url";
import { ToolRegistry } from "./mcp-handler.mjs";
import { startHttpServer } from "./http-server.mjs";
import { ESTIMATE_EVOLUTION_TOOL } from "#mcp/estimate-evolution.tool.mjs";

// Re-export so existing callers (tests, downstream tooling) can keep
// importing `buildStrategyRegistry` from this module without churn.
export { buildStrategyRegistry } from "./strategy-registry-boot.mjs";
import { buildStrategyRegistry } from "./strategy-registry-boot.mjs";

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

export function buildBootRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "__ping__",
    description: "Smoke tool — returns the input echoed back. Used to validate transport.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
    },
    async handler(args) {
      // any: smoke tool accepts arbitrary args, echoes them back
      return { echoed: args, daemon: "labre-mcp" };
    },
  });
  registry.register(ESTIMATE_EVOLUTION_TOOL);
  return registry;
}

async function main(): Promise<void> {
  const port = readPort();
  const tools = buildBootRegistry();
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
