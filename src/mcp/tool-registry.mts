// The MCP delivery's tool composition — CH-23's inverted boot wiring.
//
// WHAT INVERTED. This module used to live at `src/core/transport/
// boot-tool-registry.mts`, i.e. inside the kernel tree, and it imported five
// `#mcp/*.tool.mjs` descriptors AS VALUES: the five TRANSPORT_TO_MCP entries
// the import-boundary baseline carried. The direction is now the only one that
// can be defended — the MCP layer names its own tools, fills a kernel-owned
// `ToolRegistry`, and hands the filled instance to whichever transport is
// serving. Neither `src/core/` nor `src/transport/` mentions a tool by name.
//
// Both entrypoints (labre-daemon.mts over HTTP, labre-stdio.mts over stdio)
// build the exact same six-tool registry from here, so the surface stays
// identical regardless of how the client connects (ARCH-14).

// Side-effect: register every custom prompt parser (getPrompt().parse()). This
// import lived in the removed stdio entrypoint (mcp-server.mts) and was lost in
// the transport migration, so in production NO parser was registered and every
// parser-backed recipe/strategy (draw-value-chain, estimateEvolution, …) threw
// "parser 'X' is not registered". Both transports build the registry here, so
// registering at this shared boot point covers HTTP and stdio alike.
import "#lib/prompts/init.mjs";
import { ToolRegistry } from "#core/registry/tool-registry.mjs";
import { ESTIMATE_EVOLUTION_TOOL } from "./estimate-evolution.tool.mjs";
import { EVALUATE_MAP_TOOL } from "./evaluate-map.tool.mjs";
import { GENERATE_VALUE_CHAIN_TOOL } from "./generate-value-chain.tool.mjs";
import { RUN_COMMAND_TOOL } from "./run-command.tool.mjs";
import { RUN_RECIPE_TOOL } from "./run-recipe.tool.mjs";

export function buildMcpToolRegistry(): ToolRegistry {
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
