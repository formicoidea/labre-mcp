// MCP method dispatcher. Maps incoming JSON-RPC method names to handlers:
//   initialize → server info + capabilities
//   ping → empty success
//   notifications/initialized → no-op (one-way)
//   tools/list → list of registered tools
//   tools/call → invoke a tool by name
//   prompts/list → the METHOD surface (CH-24)
//   prompts/get → one prompt, rendered with the caller's arguments
//   resources/list → the KNOWLEDGE surface (CH-24)
//   resources/read → one resource's text
//
// Registration is decoupled from this module: the three registries are passed
// in, ALREADY FILLED by the delivery layer that owns their contents (src/mcp/).
// Since CH-23 the registry contracts themselves live in the kernel
// (#core/registry/*) and this module never names a tool, a prompt or a
// resource: the dependency points delivery → transport → kernel, one way.
//
// THE COSTUME IS OPTIONAL AT THIS SEAM (CH-24). `prompts` and `resources` are
// optional fields, and `initialize` advertises a capability only for the
// registries it was actually handed. That is not laxity — it is what makes a
// delivery that serves tools alone a legitimate delivery, and it keeps the
// handshake an honest description of what this process can answer rather than
// a hardcoded claim.

import { createRequire } from "node:module";
import { ToolRegistry, type ToolDefinition } from "#core/registry/tool-registry.mjs";
import type { PromptRegistry } from "#core/registry/prompt-registry.mjs";
import type { ResourceRegistry } from "#core/registry/resource-registry.mjs";
import { toBusinessContext, type AuthenticatedContext } from "./auth-context.mjs";
import { type JsonRpcRequest, type JsonRpcResponse, JsonRpcErrorCode } from "./json-rpc.schema.mjs";
import { withMcpDegradation } from "#lib/degradation/index.mjs";
import type { Degradable } from "#lib/degradation/types.mjs";
import {
  captureCostumeCall,
  captureToolCall,
  statusOfResult,
  telemetryDistinctId,
  type CostumeMethod,
  type TransportLabel,
} from "./tool-telemetry.mjs";

// Re-exported for the transport's own callers (http-server, stdio) so they do
// not each have to reach into the kernel for a type they only pass through.
export { ToolRegistry, type ToolDefinition };
export type { PromptRegistry, ResourceRegistry };

interface TextContentBlock {
  type: "text";
  text: string;
}

interface CallToolResult {
  content: TextContentBlock[];
  structuredContent: unknown;
}

// Version comes from package.json so a `npm version` bump propagates to what
// the server advertises (MCP initialize + HTTP /version) with no manual edit.
// Read at module load — the allowed exception to hard rule #20 (import.meta.url,
// not cwd). Path resolves to the package root in both dev (src/) and dist/.
// any: require() of package.json is untyped; we read a single field.
const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

export const SERVER_INFO = {
  name: "labre-mcp",
  version: pkg.version,
};

/**
 * What this process advertises at `initialize`. `tools` and `logging` are
 * unconditional (every delivery has a tool registry, every transport can emit
 * notifications); `prompts` and `resources` appear only when the delivery
 * actually handed over a registry — a capability is a promise, and one made
 * for a surface that will answer MethodNotFound is a lie a client acts on.
 * Neither declares `listChanged`: both catalogues are fixed for the life of
 * the process (the costume is DATA shipped with the package — ARCH-28), so
 * there is no change to subscribe to.
 */
export function serverCapabilities(options: {
  prompts?: PromptRegistry;
  resources?: ResourceRegistry;
}): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {
    tools: {},
    // The daemon emits MCP log notifications (`notifications/message`) and the
    // Claude Code chat channel (`notifications/claude/channel`) — see
    // src/lib/mcp-notifications.mts. Declare them so strict clients process them.
    logging: {},
    experimental: { "claude/channel": {} },
  };
  if (options.prompts) capabilities.prompts = {};
  if (options.resources) capabilities.resources = {};
  return capabilities;
}

export interface DispatchOptions {
  request: JsonRpcRequest;
  /** The context as the AUTH DOOR left it — business nature plus, on an
   *  authenticated HTTP request, the credential details. The dispatch is the
   *  seam: it strips the auth nature (`toBusinessContext`) and hands handlers
   *  the business context alone (CH-23 / ARCH-27). */
  context: AuthenticatedContext;
  tools: ToolRegistry;
  /** The METHOD surface (CH-24). Absent → `prompts/*` is MethodNotFound and
   *  the handshake advertises no `prompts` capability. */
  prompts?: PromptRegistry;
  /** The KNOWLEDGE surface (CH-24). Same contract as `prompts`. */
  resources?: ResourceRegistry;
  /**
   * Which wire this request arrived on, forwarded to tool telemetry so the two
   * transports are distinguishable in the data (invariant I7 — parity is a
   * claim you have to be able to CHECK). Omitted by in-process callers (tests,
   * internal handlers) → "unknown".
   */
  transport?: TransportLabel;
}

export async function dispatch(options: DispatchOptions): Promise<JsonRpcResponse | null> {
  const { request, tools, prompts, resources } = options;
  // THE SEAM. Everything below this line — the handler, the listeners it
  // attaches, every strategy it runs — sees the business nature only. A raw
  // bearer cannot reach a strategy, an artefact or a log because it is not in
  // the object they receive.
  const context = toBusinessContext(options.context);
  const transport: TransportLabel = options.transport ?? "unknown";
  const id = request.id ?? null;

  /**
   * Instrument one costume method. Same discipline as `tools/call`: the
   * measurement lives at the dispatch, once, so a method cannot ship
   * unmeasured. `target` is passed only when the entry was RESOLVED from a
   * registry — never a caller-invented id (cardinality, see tool-telemetry).
   */
  const costume = async (
    method: CostumeMethod,
    target: string | undefined,
    run: () => JsonRpcResponse | Promise<JsonRpcResponse>,
  ): Promise<JsonRpcResponse> => {
    const startedAt = Date.now();
    const distinctId = telemetryDistinctId(context);
    let response: JsonRpcResponse;
    try {
      response = await run();
    } catch (err) {
      captureCostumeCall({
        method,
        target,
        transport,
        durationMs: Date.now() - startedAt,
        status: "error",
        distinctId,
      });
      // Rethrown untouched — the outer catch turns it into the same JSON-RPC
      // InternalError it would have been without telemetry.
      throw err;
    }
    captureCostumeCall({
      method,
      target,
      transport,
      durationMs: Date.now() - startedAt,
      status: "error" in response ? "error" : "ok",
      distinctId,
    });
    return response;
  };

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
          capabilities: serverCapabilities({ prompts, resources }),
        });

      case "ping":
        return success(id, {});

      // ─── The costume (CH-24 / ARCH-28) ────────────────────────────────────
      // Four read-only methods. None runs a strategy, none calls a model, none
      // takes a caller-supplied path: a prompt renders text this package ships,
      // a resource returns a document this package ships. They pass the SAME
      // auth door as `tools/*` — the HTTP transport authenticates the whole
      // POST /mcp before dispatch is reached, so there is no per-method
      // exemption to write and none to forget.

      case "prompts/list": {
        if (!prompts) return error(id, JsonRpcErrorCode.MethodNotFound, "Method not found: prompts/list");
        return costume("prompts/list", undefined, () => success(id, { prompts: prompts.list() }));
      }

      case "prompts/get": {
        if (!prompts) return error(id, JsonRpcErrorCode.MethodNotFound, "Method not found: prompts/get");
        // any: params validated below
        const params = (request.params as { name?: string; arguments?: unknown }) ?? {};
        if (!params.name || typeof params.name !== "string") {
          return costume("prompts/get", undefined, () =>
            error(id, JsonRpcErrorCode.InvalidParams, "prompts/get requires a 'name' string parameter"),
          );
        }
        const prompt = prompts.get(params.name);
        if (!prompt) {
          // No target: the name came from the caller and nothing bounds it.
          return costume("prompts/get", undefined, () =>
            error(id, JsonRpcErrorCode.InvalidParams, `Unknown prompt: ${params.name}`),
          );
        }
        return costume("prompts/get", prompt.name, () => {
          let messages;
          try {
            messages = prompt.render(toStringArguments(params.arguments));
          } catch (err) {
            // A missing required argument is the caller's mistake, reported as
            // such. The message names the arguments, never their values.
            return error(id, JsonRpcErrorCode.InvalidParams, (err as Error).message);
          }
          return success(id, {
            description: prompt.description,
            messages: messages.map((m) => ({
              role: m.role,
              content: { type: "text", text: m.text },
            })),
          });
        });
      }

      case "resources/list": {
        if (!resources) return error(id, JsonRpcErrorCode.MethodNotFound, "Method not found: resources/list");
        return costume("resources/list", undefined, () => success(id, { resources: resources.list() }));
      }

      case "resources/read": {
        if (!resources) return error(id, JsonRpcErrorCode.MethodNotFound, "Method not found: resources/read");
        // any: params validated below
        const params = (request.params as { uri?: string }) ?? {};
        if (!params.uri || typeof params.uri !== "string") {
          return costume("resources/read", undefined, () =>
            error(id, JsonRpcErrorCode.InvalidParams, "resources/read requires a 'uri' string parameter"),
          );
        }
        const resource = resources.get(params.uri);
        if (!resource) {
          return costume("resources/read", undefined, () =>
            error(id, JsonRpcErrorCode.ResourceNotFound, `Unknown resource: ${params.uri}`),
          );
        }
        return costume("resources/read", resource.uri, async () => {
          const text = await resource.read();
          return success(id, {
            contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }],
          });
        });
      }

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
        // CH-09 / invariant I7: telemetry is enforced HERE, once, for the same
        // reason degradation is (hard rule #18) — a tool that has to remember
        // to instrument itself eventually forgets, and four of the five did.
        // Every tool, on either transport, emits exactly one `mcp_tool_call`.
        const args = params.arguments ?? {};
        const startedAt = Date.now();
        const distinctId = telemetryDistinctId(context);
        let target: string | undefined;
        try {
          target = tool.telemetryTarget?.(args);
        } catch {
          // A broken extractor costs the target dimension, never the call.
          target = undefined;
        }

        // ARCH-22 / hard rule #18: every tool handler is wrapped here, once,
        // so each tools/call response is a Degradable<T> envelope and any
        // tryDegradeAmbient deep in the call tree records into the ambient
        // collector (AsyncLocalStorage). Handlers must NOT self-wrap.
        let degradable: Degradable<unknown>;
        try {
          degradable = await withMcpDegradation(params.name, () => tool.handler(args, context));
        } catch (err) {
          // The handler threw (Zod rejection, unhandled fault). There is no
          // collector to read, so `degraded` is reported false rather than
          // guessed. Rethrown untouched: the outer catch still turns it into
          // the same JSON-RPC error as before — telemetry changes nothing on
          // the wire. No error message is captured (privacy: a Zod message
          // quotes the caller's input).
          captureToolCall({
            tool: tool.name,
            target,
            transport,
            durationMs: Date.now() - startedAt,
            status: "error",
            degraded: false,
            distinctId,
          });
          throw err;
        }
        captureToolCall({
          tool: tool.name,
          target,
          transport,
          durationMs: Date.now() - startedAt,
          // In-band failures (`{ status: 'error' }`) count as errors — see
          // statusOfResult.
          status: statusOfResult(degradable.result),
          degraded: degradable.degraded,
          distinctId,
        });
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

/**
 * Normalise `prompts/get` arguments to the flat string map a prompt renders
 * from. MCP declares prompt arguments as strings; a client that sends a number
 * or a boolean gets it stringified rather than a rejection, and anything
 * structured (object, array) is JSON-encoded so a prompt expecting a metadata
 * blob still receives it as text. `null` / `undefined` entries are dropped so
 * they read as ABSENT — which is what makes the required-argument check
 * (requireArguments, kernel side) mean what it says.
 */
function toStringArguments(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
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
