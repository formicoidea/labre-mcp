// The kernel's TOOL REGISTRY — the seam through which a delivery layer hands
// its callable surface to a transport (CH-23, ARCH-27).
//
// WHY THIS LIVES IN THE KERNEL. Before CH-23 this contract lived inside
// `mcp-handler.mts`, i.e. inside the transport, and the boot wiring reached
// UP from the transport into `src/mcp/` to fill it — six import-boundary
// violations, and the reason "run this tool" was not callable without a
// JSON-RPC dispatcher. Inverting it costs exactly this file: the kernel owns
// the registry TYPE, the delivery layer (src/mcp/) composes ITS tools into an
// instance, and the transport receives that instance already filled. Nothing
// under src/core/ or src/transport/ names a single tool.
//
// WHAT IT IS NOT. This is not an MCP type. A `ToolDefinition` is a named
// callable with an opaque JSON-Schema-shaped input description and a handler
// taking the business context; `inputSchema` is a `Record<string, unknown>`
// precisely so the kernel never has to know the protocol that serialises it.
// The MCP-specific parts — JSON-RPC framing, `tools/call` shaping, degradation
// envelopes — stay in the transport's dispatcher.

import type { RequestContext } from "../context/request-context.mjs";

export interface ToolDefinition {
  name: string;
  description: string;
  // any: per-tool input shape — opaque at the registry level (handler validates)
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, context: RequestContext) => Promise<unknown>;
  /**
   * Optional telemetry enrichment (CH-09, invariant I7): name WHAT this call
   * targeted — a 5-segment methodId for `runCommand`, a 3-segment recipe ref
   * for the recipe-backed tools. The dispatch emits `mcp_tool_call` for every
   * tool whether or not this is declared; the target is the one dimension only
   * the tool can supply.
   *
   * The extractor MUST validate the value against the tool's own schema before
   * returning it (never return a raw caller string): the result becomes a
   * PostHog property, and an unbounded property is a cardinality leak. Return
   * `undefined` for anything that does not validate. Throwing is tolerated —
   * the dispatch treats it as "no target".
   */
  telemetryTarget?: (args: unknown) => string | undefined;
}

export class ToolRegistry {
  private readonly map = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.map.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`);
    }
    this.map.set(tool.name, tool);
  }

  list(): Array<Pick<ToolDefinition, "name" | "description" | "inputSchema">> {
    return [...this.map.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  get(name: string): ToolDefinition | undefined {
    return this.map.get(name);
  }
}
