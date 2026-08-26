// Extract a RequestContext from an MCP JSON-RPC request body. Clients embed
// labre-mcp context in the params._context envelope; absent fields default
// to dev-mode placeholders so existing simple clients (curl, smoke tests)
// keep working in V1.
//
// V3 SaaS will require the context to be present and authenticated — the
// no-op auth middleware (auth-middleware.mts) becomes the gating point.

import { randomUUID } from "node:crypto";
import { type RequestContext, RequestContextSchema } from "#core/context/request-context.mjs";

const DEFAULT_PROJECT_ROOT = process.cwd();

/** Fields a CALLER may never assert about itself. `userId` is stamped by the
 *  auth middleware from a verified credential (auth-context.mts, `withAuth`) or
 *  it is absent — a client-supplied one is dropped here, before the middleware
 *  even runs. Pre-CH-23 the whole `auth` sub-object was equally client-writable
 *  through this path; the split makes that impossible for the credential
 *  fields (they are no longer part of the business schema at all) and this
 *  filter closes the remaining one. */
const CALLER_FORBIDDEN_FIELDS = ["userId"] as const;

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
      if (parsed.success) {
        const clean = { ...parsed.data };
        for (const field of CALLER_FORBIDDEN_FIELDS) delete clean[field];
        return clean;
      }
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
