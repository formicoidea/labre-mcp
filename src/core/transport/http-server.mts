// HTTP entry point for the labre-mcp daemon (ARCH-14).
// Hono app exposes POST /mcp accepting JSON-RPC 2.0 over HTTP.
// Other endpoints:
//   GET /health → liveness probe
//   GET /version → server info

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { dispatch, type ToolRegistry } from "./mcp-handler.mjs";
import { JsonRpcRequestSchema } from "./json-rpc.schema.mjs";
import { extractContext } from "./context-extractor.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { noopAuthMiddleware } from "./auth-middleware.mjs";

export interface HttpServerOptions {
  port: number;
  tools: ToolRegistry;
  auth?: AuthMiddleware;
  hostname?: string;
}

export interface RunningServer {
  close(): Promise<void>;
  port: number;
}

export function buildApp(options: { tools: ToolRegistry; auth: AuthMiddleware }): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/version", (c) =>
    c.json({ name: "labre-mcp", version: "1.0.0-migration" }),
  );

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
    const context = await options.auth.authenticate(headers, initialContext);

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
