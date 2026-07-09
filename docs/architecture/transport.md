# Transport

> Cross-references: [ADR-11](decisions.md#arch-11--v1-is-synchronous-requestresponse-only) (sync only), [ADR-14](decisions.md#arch-14--daemon-http-localhost-transport-saas-ready-by-design) (HTTP daemon), [ADR-15](decisions.md#arch-15--processcwd-forbidden-at-runtime-context-propagated-explicitly) (context propagation).

## Overview

labre-mcp runs as a locally-installed daemon exposing the MCP protocol over HTTP. The transport choice is intentionally identical to the eventual V3 SaaS deployment — same JSON-RPC envelopes, same context model, only the host and authentication change.

```
client (Claude Code, curl, custom)
  │
  ▼
POST /mcp  (JSON-RPC 2.0 body)
  │
  ▼
Hono app  ────►  auth middleware  ────►  context extractor  ────►  MCP dispatcher
                  (no-op V1)           (RequestContext from body)   │
                                                                     ├─ initialize
                                                                     ├─ ping
                                                                     ├─ tools/list
                                                                     └─ tools/call → tool registry → recipe runner → AST
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe. Returns `{ status: "ok" }`. |
| `GET` | `/version` | Server info: `{ name: "labre-mcp", version }`. |
| `POST` | `/mcp` | JSON-RPC 2.0 dispatch. Body must conform to [`JsonRpcRequestSchema`](../../src/core/transport/json-rpc.schema.mts). |

The `/mcp` endpoint accepts these MCP methods:

- `initialize` — handshake, returns server info + capabilities.
- `ping` — empty success response.
- `notifications/*` — one-way (no JSON-RPC id); returns HTTP 204.
- `tools/list` — list registered tools.
- `tools/call` — invoke a tool by name with arguments.

## Boot path

The canonical entrypoint is the HTTP daemon in [`src/core/transport/labre-daemon.mts`](../../src/core/transport/labre-daemon.mts), launched by `pnpm mcp` (dev) or `pnpm mcp:prod` (post-`pnpm build`). The daemon:

1. Builds the strategy registry via `buildStrategyRegistry()`.
2. Builds the MCP tool registry via `buildBootRegistry()` — four tools: `__ping__` (smoke), `estimateEvolution` (recipe `estimate-component-evolution`), `runCommand` (generic direct invocation of any 5-segment methodId → `CommandResult`), and `runRecipe` (generic invocation of any multi-step recipe by `<domain>:<tool>:<name>` ref → JSON-labre envelope + final AST + artefact path).
3. Boots the HTTP server on `LABRE_HTTP_PORT` (default `6767`).
4. Logs the registered tool list and the strategy methodIds.

The `.mcp.json` at the repo root declares the labre-mcp server with HTTP transport (`"type": "http"`, `"url": "http://127.0.0.1:6767/mcp"`), so Claude Code connects to the running daemon rather than spawning a fresh stdio server. There is no stdio entrypoint: the old `src/mcp/mcp-server.mts` was removed during the migration.

## Configuration

The daemon reads the port from `LABRE_HTTP_PORT` (default `6767`) and the bind address from `LABRE_HTTP_HOST` (default `127.0.0.1`, loopback-only). Production deployments behind a PaaS router set `LABRE_HTTP_HOST=0.0.0.0`; a local daemon stays loopback-only unless explicitly opted in.

### Shipped recipes location

MCP tool handlers load canonical recipes from `<shippedRoot>/recipes/...` and merge them with per-project overrides at `<projectRoot>/recipes/...` (ARCH-08). The `shippedRoot` is resolved in this order:

1. `LABRE_SHIPPED_ROOT` env var — required when running from a bundled single-file build where the source layout is flattened.
2. Auto-detection from `import.meta.url`: the handler file's location plus two `..` segments resolves to the repo root in both dev (tsx) and standard prod (node dist/) layouts.

Override via env is the escape hatch when auto-detection cannot work (esbuild bundling, npm-installed dependency layouts, container images that move files around).

Start the daemon:

```
pnpm run mcp:http              # dev (tsx)
pnpm run mcp:http:prod         # prod (node dist/)
```

## Context propagation (ARCH-15)

Every tool call carries a `RequestContext` embedded in `params._context`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "evaluateMap",
    "arguments": { "filePath": "maps/spotify.wm" },
    "_context": {
      "projectId": "abc123",
      "projectRoot": "/home/user/wardley-project",
      "sessionId": "uuid",
      "domain": "wardley"
    }
  }
}
```

If `_context` is missing, the daemon falls back to dev-mode placeholders (`projectId = "default"`, `projectRoot = process.cwd()`). V3 SaaS will reject context-less requests at the auth middleware.

**Rule**: tool handlers must not read `process.cwd()` or `process.env.X` at runtime. The boot-time `process.cwd()` is captured once and exposed only as the default `projectRoot`. Per-request paths are resolved against `context.projectRoot`.

## Auth middleware

V1 ships [`noopAuthMiddleware`](../../src/core/transport/auth-middleware.mts) which passes context through untouched. The handler chain is:

```ts
context = await auth.authenticate(httpHeaders, contextFromBody);
```

V3 SaaS replaces `noopAuthMiddleware` with a real implementation (OAuth/API key validation, tenant extraction). No tool handler changes.

## Synchronous only (ARCH-11)

V1 is request/response. There is no run-id polling, no SSE streaming, no `subscribeRun(runId)`. Each tool call blocks until the recipe (and all its listeners) complete. Long-running recipes (agent strategies in V1.5+) block accordingly.

This aligns with the ping-pong nature of LLM↔MCP interaction. Async run patterns are reserved for V3 if needed; their introduction is additive (new endpoints), not breaking.

## Smoke test

```bash
curl -s http://127.0.0.1:6767/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
# {"jsonrpc":"2.0","id":1,"result":{}}
```

For an end-to-end tool call, see [`http-server.test.mts`](../../src/core/transport/http-server.test.mts).
