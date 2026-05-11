// JSON-RPC 2.0 envelope shapes used over HTTP for MCP requests.
// We hand-roll the envelopes (rather than using the @modelcontextprotocol/sdk
// HTTP transport) to keep full control over context extraction and auth
// middleware (ARCH-14, ARCH-15).

import { z } from "zod";

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcSuccessSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown(),
});

export const JsonRpcErrorSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});

// any: response is either success or error — discriminated at the runtime layer
export type JsonRpcResponse =
  | z.infer<typeof JsonRpcSuccessSchema>
  | z.infer<typeof JsonRpcErrorSchema>;

// Standard JSON-RPC 2.0 error codes
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;
