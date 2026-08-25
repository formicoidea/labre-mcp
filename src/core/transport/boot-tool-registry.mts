// Shared MCP tool-registry boot logic, transport-agnostic.
// Both the HTTP daemon (labre-daemon.mts) and the stdio entrypoint
// (labre-stdio.mts) build the exact same six-tool registry from here, so the
// surface stays identical regardless of how the client connects (ARCH-14).

// Side-effect: register every custom prompt parser (getPrompt().parse()). This
// import lived in the removed stdio entrypoint (mcp-server.mts) and was lost in
// the transport migration, so in production NO parser was registered and every
// parser-backed recipe/strategy (draw-value-chain, estimateEvolution, …) threw
// "parser 'X' is not registered". Both transports build the registry here, so
// registering at this shared boot point covers HTTP and stdio alike.
import "#lib/prompts/init.mjs";
import { ToolRegistry } from "./mcp-handler.mjs";
import { ESTIMATE_EVOLUTION_TOOL } from "#mcp/estimate-evolution.tool.mjs";
import { EVALUATE_MAP_TOOL } from "#mcp/evaluate-map.tool.mjs";
import { GENERATE_VALUE_CHAIN_TOOL } from "#mcp/generate-value-chain.tool.mjs";
import { RUN_COMMAND_TOOL } from "#mcp/run-command.tool.mjs";
import { RUN_RECIPE_TOOL } from "#mcp/run-recipe.tool.mjs";

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
  // Multi-step recipes with a dedicated, discoverable input schema (B3).
  registry.register(EVALUATE_MAP_TOOL);
  registry.register(GENERATE_VALUE_CHAIN_TOOL);
  registry.register(RUN_COMMAND_TOOL);
  registry.register(RUN_RECIPE_TOOL);
  return registry;
}
