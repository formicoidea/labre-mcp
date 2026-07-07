// MCP method dispatcher. Maps incoming JSON-RPC method names to handlers:
//   initialize → server info + capabilities
//   ping → empty success
//   notifications/initialized → no-op (one-way)
//   tools/list → list of registered tools
//   tools/call → invoke a tool by name
//
// Tool registration is decoupled from this module: a ToolRegistry is passed
// in. Concrete tools (estimateEvolution, evaluateMap, etc.) register
// themselves at boot. CP4-CP6 will migrate the existing 5 tools to this
// registry; CP3 ships with the registry empty (or holding only smoke tools).

import { createRequire } from "node:module";
import type { RequestContext } from "../context/request-context.mjs";
import { type JsonRpcRequest, type JsonRpcResponse, JsonRpcErrorCode } from "./json-rpc.schema.mjs";
import { withMcpDegradation } from "#lib/degradation/index.mjs";
import type { Degradable } from "#lib/degradation/types.mjs";

export interface ToolDefinition {
  name: string;
  description: string;
  // any: per-tool input shape — opaque at the dispatcher level (handler validates)
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, context: RequestContext) => Promise<unknown>;
}

interface TextContentBlock {
  type: "text";
  text: string;
}

interface CallToolResult {
  content: TextContentBlock[];
  structuredContent: unknown;
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

// Version comes from package.json so a `npm version` bump propagates to what
// the server advertises (MCP initialize + HTTP /version) with no manual edit.
// Read at module load — the allowed exception to hard rule #20 (import.meta.url,
// not cwd). Path resolves to the package root in both dev (src/) and dist/.
// any: require() of package.json is untyped; we read a single field.
const pkg = createRequire(import.meta.url)("../../../package.json") as { version: string };

export const SERVER_INFO = {
  name: "labre-mcp",
  version: pkg.version,
};

const SERVER_CAPABILITIES = {
  tools: {},
  // The daemon emits MCP log notifications (`notifications/message`) and the
  // Claude Code chat channel (`notifications/claude/channel`) — see
  // src/lib/mcp-notifications.mts. Declare them so strict clients process them.
  logging: {},
  experimental: { "claude/channel": {} },
};

export interface DispatchOptions {
  request: JsonRpcRequest;
  context: RequestContext;
  tools: ToolRegistry;
}

export async function dispatch(options: DispatchOptions): Promise<JsonRpcResponse | null> {
  const { request, context, tools } = options;
  const id = request.id ?? null;

  // Notifications (no id) — one-way, no response.
  if (request.method.startsWith("notifications/")) {
    return null;
  }

  try {
    switch (request.method) {
      case "initialize":
        return success(id, {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: SERVER_CAPABILITIES,
        });

      case "ping":
        return success(id, {});

      case "tools/list":
        return success(id, { tools: tools.list() });

      case "tools/call": {
        // any: params validated below
        const params = (request.params as { name?: string; arguments?: unknown }) ?? {};
        if (!params.name || typeof params.name !== "string") {
          return error(id, JsonRpcErrorCode.InvalidParams, "tools/call requires a 'name' string parameter");
        }
        const tool = tools.get(params.name);
        if (!tool) {
          return error(id, JsonRpcErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
        }
        // ARCH-22 / hard rule #18: every tool handler is wrapped here, once,
        // so each tools/call response is a Degradable<T> envelope and any
        // tryDegradeAmbient deep in the call tree records into the ambient
        // collector (AsyncLocalStorage). Handlers must NOT self-wrap.
        const degradable = await withMcpDegradation(params.name, () =>
          tool.handler(params.arguments ?? {}, context),
        );
        return success(id, toCallToolResult(degradable));
      }

      default:
        return error(id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${request.method}`);
    }
  } catch (err) {
    return error(id, JsonRpcErrorCode.InternalError, (err as Error).message ?? String(err));
  }
}

function success(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function toCallToolResult<T>(degradable: Degradable<T>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(degradable) }],
    structuredContent: degradable,
  };
}

function error(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}
