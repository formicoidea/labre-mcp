// Extract a RequestContext from an MCP JSON-RPC request body. Clients embed
// labre-mcp context in the params._context envelope; absent fields default
// to dev-mode placeholders so existing simple clients (curl, smoke tests)
// keep working in V1.
//
// V3 SaaS will require the context to be present and authenticated — the
// no-op auth middleware (auth-middleware.mts) becomes the gating point.

import { randomUUID } from "node:crypto";
import { type RequestContext, RequestContextSchema } from "../context/request-context.mjs";

const DEFAULT_PROJECT_ROOT = process.cwd();

export function extractContext(params: unknown): RequestContext {
  // any: params shape is open at the JSON-RPC layer.
  // Two embed locations are accepted: top-level `params._context` (clean
  // envelope) and `params.arguments._context` (tools/call convention where
  // callers tuck context alongside other args). First match wins.
  const topLevel = (params as { _context?: unknown })?._context;
  const fromArgs = (params as { arguments?: { _context?: unknown } })?.arguments?._context;
  for (const ctx of [topLevel, fromArgs]) {
    if (ctx && typeof ctx === "object") {
      const parsed = RequestContextSchema.safeParse(ctx);
      if (parsed.success) return parsed.data;
    }
  }

  // Fallback for ad-hoc clients in V1 only — boot-time projectRoot.
  return {
    projectId: "default",
    projectRoot: DEFAULT_PROJECT_ROOT,
    sessionId: randomUUID(),
    domain: "wardley",
  };
}
