// Daemon entrypoint for labre-mcp HTTP transport (ARCH-14).
// Boots the HTTP server on the configured port AND the strategy registry
// (ARCH-03). The strategy registry is populated by importing each
// framework's `registry.mts`, which calls `registerXxxStrategies(reg)`.
// MCP tool handlers consume this registry via the recipe runner to
// resolve methodIds at call time.

import { fileURLToPath } from "node:url";
import { ToolRegistry } from "./mcp-handler.mjs";
import { startHttpServer } from "./http-server.mjs";
import { StrategyRegistry } from "../registry/strategy-registry.mjs";
import type { BaseStrategy } from "../ast/base-strategy.mjs";
import { registerEvolutionStrategies } from "#frameworks/wardley/evolution/registry.mjs";
import { registerChainStrategies } from "#frameworks/wardley/chain/registry.mjs";
import { registerCommonStrategies } from "#frameworks/common/registry.mjs";
import { handleEstimateEvolutionViaRecipe } from "#mcp/estimate-evolution-via-recipe.mjs";
import { EstimateEvolutionInputSchema } from "#schemas/estimate-evolution.schema.mjs";
import { z } from "zod";

const DEFAULT_PORT = 3000;

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
  registry.register({
    name: "estimateEvolution",
    description:
      "Estimate the Wardley Map evolution position of a component via the recipe runner. " +
      "Dispatches through the canonical estimate-component recipe (read:component:identify-capability → write:capacity:llm-direct). " +
      "Returns recipeRunId, the AST, the events trace, and the artifact path under ~/.labre-mcp/runs/.",
    // any: zod-to-json conversion — the schema is well-typed at the Zod layer
    inputSchema: z.toJSONSchema(EstimateEvolutionInputSchema, { io: "input" }) as Record<string, unknown>,
    async handler(args, context) {
      // any: args is the open MCP arguments envelope; the handler validates internally
      return handleEstimateEvolutionViaRecipe({
        ...(args as Record<string, unknown>),
        _context: context,
      });
    },
  });
  return registry;
}

/**
 * Build the strategy registry by importing every framework's register function.
 * Each framework module side-effects-imports its strategy classes at load time;
 * the register function wires them into the shared registry. Idempotent (throws
 * on duplicate methodId — catches accidental double-boot).
 */
export function buildStrategyRegistry(): StrategyRegistry<BaseStrategy> {
  const registry = new StrategyRegistry<BaseStrategy>();
  registerEvolutionStrategies(registry);
  registerChainStrategies(registry);
  registerCommonStrategies(registry);
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
