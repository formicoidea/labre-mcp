// HTTP entry point for the labre-mcp daemon (ARCH-14).
// Hono app exposes POST /mcp accepting JSON-RPC 2.0 over HTTP.
// Other endpoints:
//   GET /health → liveness probe
//   GET /version → server info
//   GET /.well-known/oauth-protected-resource → OAuth discovery (opt-in)
//
// OAuth resource-server role (MCP authorization spec): the daemon stays a pure
// RESOURCE server — it validates bearer tokens (JWKS, via the auth middleware)
// but never mints them. When configured, it advertises WHICH authorization
// server issues its tokens (labre) via RFC 9728 protected-resource metadata,
// and points 401s at that metadata with a WWW-Authenticate header. The AS
// itself (authorize/token/registration) lives in the labre app, not here.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { dispatch, SERVER_INFO, type ToolRegistry } from "./mcp-handler.mjs";
import { JsonRpcRequestSchema, JsonRpcErrorCode } from "./json-rpc.schema.mjs";
import { extractContext } from "./context-extractor.mjs";
import type { RequestContext } from "../context/request-context.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { noopAuthMiddleware, AuthenticationError } from "./auth-middleware.mjs";

/**
 * OAuth 2.0 protected-resource discovery (RFC 9728), opt-in. When set, the
 * daemon serves /.well-known/oauth-protected-resource and stamps 401s with a
 * WWW-Authenticate header so an OAuth-capable MCP client (claude.ai connectors)
 * discovers the authorization server. Absent → no discovery surface, 401s stay
 * plain (the lab_/JWT static-bearer path is unaffected).
 */
export interface OAuthResourceConfig {
  /** Canonical resource URL — the public MCP endpoint,
   *  e.g. https://framework-mcp.labre.app/mcp */
  resource: string;
  /** Authorization server base URL (the labre app), e.g. https://labre.app */
  authServer: string;
}

/**
 * Invoked after successful authentication and before dispatch (e.g. the
 * Supabase bundle source refreshing with the caller's bearer token). Errors
 * NEVER fail the request — they are logged to stderr and dispatch proceeds.
 */
export type OnAuthenticatedHook = (
  headers: Record<string, string>,
  context: RequestContext,
) => Promise<void>;

export interface HttpServerOptions {
  port: number;
  tools: ToolRegistry;
  auth?: AuthMiddleware;
  hostname?: string;
  onAuthenticated?: OnAuthenticatedHook;
  oauth?: OAuthResourceConfig;
}

export interface RunningServer {
  close(): Promise<void>;
  port: number;
}

export function buildApp(options: {
  tools: ToolRegistry;
  auth: AuthMiddleware;
  onAuthenticated?: OnAuthenticatedHook;
  oauth?: OAuthResourceConfig;
}): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/version", (c) => c.json(SERVER_INFO));

  // OAuth protected-resource discovery (RFC 9728), opt-in. Public metadata —
  // no auth. Points OAuth-capable clients at labre (the authorization server).
  // The metadata URL sits at the resource ORIGIN's well-known path; it is also
  // the value stamped into 401 WWW-Authenticate headers below.
  const resourceMetadataUrl = options.oauth
    ? new URL(
        "/.well-known/oauth-protected-resource",
        new URL(options.oauth.resource).origin,
      ).toString()
    : undefined;
  if (options.oauth) {
    const metadata = {
      resource: options.oauth.resource,
      authorization_servers: [options.oauth.authServer],
    };
    app.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata));
  }

  app.post("/mcp", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }

    const parsed = JsonRpcRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request", data: parsed.error.issues },
        },
        400,
      );
    }

    const headers = Object.fromEntries(c.req.raw.headers);
    const initialContext = extractContext(parsed.data.params);

    // Authenticate BEFORE dispatch; the enriched context (auth claims)
    // travels with the tool call. Fail closed with 401 — the internal
    // reason is never leaked to the caller.
    let context;
    try {
      context = await options.auth.authenticate(headers, initialContext);
    } catch (err) {
      if (err instanceof AuthenticationError) {
        // Point OAuth-capable clients at the AS via RFC 9728 discovery. Only
        // when configured — otherwise the static-bearer 401 stays plain.
        if (resourceMetadataUrl) {
          c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
        }
        return c.json(
          {
            jsonrpc: "2.0",
            id: parsed.data.id ?? null,
            error: { code: JsonRpcErrorCode.Unauthorized, message: "unauthorized" },
          },
          401,
        );
      }
      throw err;
    }

    // Post-auth hook (e.g. lazy remote-bundle refresh with the caller's
    // token). Best effort: a hook failure must never fail the request.
    if (options.onAuthenticated) {
      try {
        await options.onAuthenticated(headers, context);
      } catch (err) {
        process.stderr.write(
          `[labre-mcp] onAuthenticated hook failed (request continues): ${(err as Error).message}\n`,
        );
      }
    }

    const response = await dispatch({
      request: parsed.data,
      context,
      tools: options.tools,
    });

    if (response === null) {
      // Notification — no body, just 204.
      return new Response(null, { status: 204 });
    }
    return c.json(response);
  });

  return app;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningServer> {
  const app = buildApp({
    tools: options.tools,
    auth: options.auth ?? noopAuthMiddleware,
    onAuthenticated: options.onAuthenticated,
    oauth: options.oauth,
  });

  let server: ServerType | undefined;
  await new Promise<void>((resolve) => {
    server = serve(
      {
        fetch: app.fetch,
        port: options.port,
        hostname: options.hostname ?? "127.0.0.1",
      },
      () => resolve(),
    );
  });

  return {
    port: options.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
