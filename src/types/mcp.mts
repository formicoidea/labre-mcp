// MCP (Model Context Protocol) types.
//
// JSON-RPC 2.0 message shapes + tool definitions used by src/mcp/mcp-server.mjs.
// Protocol spec: https://modelcontextprotocol.io/specification

/** JSON Schema loosely typed — MCP tools declare their inputSchema as a JSON Schema object. */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  /** Autres propriétés du JSON Schema (allOf, oneOf, etc.) */
  [key: string]: unknown;
}

/** Définition d'un outil MCP exposé au client. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * Handler dispatched by the MCP server for a tool.
 *
 * The optional second parameter is a `DegradationCollector` (typed as
 * `unknown` here to keep this types module dependency-free). Handlers that
 * have been migrated to the degradation framework consume it; legacy
 * handlers simply ignore the second argument.
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  collector?: unknown,
) => Promise<unknown>;

// ─── JSON-RPC 2.0 ──────────────────────────────────────────────────────────

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcResponse<T = unknown> =
  | JsonRpcSuccessResponse<T>
  | JsonRpcErrorResponse;

// ─── MCP initialize handshake ──────────────────────────────────────────────

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpServerCapabilities {
  tools?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: McpServerInfo;
  capabilities: McpServerCapabilities;
  instructions?: string;
}
