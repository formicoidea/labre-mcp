# Transport

> Cross-references: [ADR-11](decisions.md#arch-11--v1-is-synchronous-requestresponse-only) (sync only), [ADR-14](decisions.md#arch-14--daemon-http-localhost-transport-saas-ready-by-design) (HTTP daemon), [ADR-15](decisions.md#arch-15--processcwd-forbidden-at-runtime-context-propagated-explicitly) (context propagation), [ADR-27](decisions.md#arch-27--the-façade-labre-mcp-is-a-kernel-with-deliveries-mcp-is-one-of-them) (the façade — the transport names nothing), [ADR-28](decisions.md#arch-28--the-mcp-costume-prompts-and-resources-served-from-the-kernel-data-only) (the costume).

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
                                                                     ├─ tools/call     → tool registry     → recipe runner → AST
                                                                     ├─ prompts/list   ┐
                                                                     ├─ prompts/get    ├ the COSTUME (ARCH-28)
                                                                     ├─ resources/list │ → prompt / resource registry
                                                                     └─ resources/read ┘   → kernel data catalogues
```

Every method above the dashed line and below it passes the SAME auth door: the
middleware runs once, for the whole `POST /mcp`, before the dispatcher is
reached. There is no per-method exemption.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe. Returns `{ status: "ok" }`. |
| `GET` | `/version` | Server info: `{ name: "labre-mcp", version }`. |
| `GET` | `/config/llm` | Read-only live LLM config for the Labre admin console, **opt-in**. Present only when `LABRE_MCP_ADMIN_TOKEN` is set (else `503`); requires `Authorization: Bearer <token>` (`401` otherwise). Returns `{ defaultProvider, providers, strategies }` with a per-provider `hasKey` boolean — never secret values. |
| `GET` | `/.well-known/oauth-protected-resource` | OAuth discovery (RFC 9728), **opt-in**. Present only when `LABRE_OAUTH_RESOURCE` + `LABRE_OAUTH_AUTH_SERVER` are set. Returns `{ resource, authorization_servers: [<labre AS>] }`. |
| `POST` | `/mcp` | JSON-RPC 2.0 dispatch. Body must conform to [`JsonRpcRequestSchema`](../../src/transport/json-rpc.schema.mts). |

The `/mcp` endpoint accepts these MCP methods:

- `initialize` — handshake, returns server info + capabilities.
- `ping` — empty success response.
- `notifications/*` — one-way (no JSON-RPC id); returns HTTP 204.
- `tools/list` — list registered tools.
- `tools/call` — invoke a tool by name with arguments.
- `prompts/list` — list the published METHOD prompts (ARCH-28).
- `prompts/get` — render one prompt with the caller's arguments. Unknown name → `-32602`; missing required argument → `-32602` naming the argument.
- `resources/list` — list the published KNOWLEDGE documents (ARCH-28).
- `resources/read` — read one document by `labre://` URI. Unknown URI → `-32002` (MCP's reserved `ResourceNotFound`).

## The costume — prompts and resources (ARCH-28)

`initialize` advertises `prompts` / `resources` **only when the composition root handed the dispatch a registry for them**; a delivery that serves tools alone advertises neither and answers `MethodNotFound`. Neither declares `listChanged` — both catalogues are fixed for the life of the process.

**Prompts (6).** The method behind the Wardley strategies, handed over as text a third-party harness can run on its own model: `identify-capability`, `anchor-evolution`, `historical-evolution__with-capability`, `publication-analysis`, `write-chain__top-down`, `purpose-generate`. The selection criterion is stated in the module header of [`src/mcp/prompt-registry.mts`](../../src/mcp/prompt-registry.mts) and in ARCH-28. Each declares its variables as MCP arguments; exactly one — the prompt's primary subject — is `required`. MCP prompt messages have no `system` role, so the invariant system half is returned as the FIRST user message and the interpolated user half as the second.

**Resources (7), under one URI scheme:**

```
labre://<category>[/<id>]

labre://grammar          the 5-segment addressing rules (regex included)
labre://methods          the LIVE methodId catalogue: real / mock / disabled + counts
labre://recipes          the shipped recipes, with the refs runRecipe accepts
labre://schemas/<id>     one published JSON Schema (<id> = filename minus .schema.json):
                         command-call, command-result, json-labre, wardley-map
```

A URI names a **category**, never a version or a path on disk. `schemas/` is the only category with an id segment, and its ids come from the shipped directory listing — no caller string is ever resolved into a path. The schema category **mirrors `GET /schemas/:file`**: same directory, same filename allowlist, so the two surfaces cannot disagree.

Nothing is parameterised: `resources/read` takes a URI and nothing else. A parameterised resource would be a tool wearing a URI, and run-time-loaded content is C4 / CH-26, not this.

Telemetry: these four methods emit `mcp_costume_call` (not `mcp_tool_call` — a free catalogue read is not a tool call), with `method`, `transport`, `durationMs`, `status`, and `target` only when the entry actually resolved. Pinned by the parity matrix in [`tool-telemetry-matrix.test.mts`](../../src/mcp/tool-telemetry-matrix.test.mts).

See the costume live, with no port and no model:

```bash
pnpm demo:costume
```

## Boot path

The canonical entrypoint is the HTTP daemon in [`src/mcp/labre-daemon.mts`](../../src/mcp/labre-daemon.mts), launched by `pnpm mcp` (dev) or `pnpm mcp:prod` (post-`pnpm build`). The daemon:

1. `src/mcp/labre-daemon.mts` builds the strategy registry via `buildStrategyRegistry()` (`src/frameworks/registry-boot.mts`), the MCP tool registry, and — since ARCH-28 — the prompt and resource registries, then hands them ALL to `startHttpDaemon` (`src/transport/http-daemon.mts`). Since ARCH-27 the transport composes nothing.
2. Builds the MCP tool registry via `buildMcpToolRegistry()` — six tools: `__ping__` (smoke), `estimateEvolution` (recipe `estimate-component-evolution`), `generateValueChain` (recipe `generate`), `evaluateMap` (recipe `evaluate-map`), `runCommand` (generic direct invocation of any 5-segment methodId → `CommandResult`), and `runRecipe` (generic invocation of any multi-step recipe by `<domain>:<tool>:<name>` ref → JSON-labre envelope + final AST + artefact path).
3. Builds the costume via `buildMcpPromptRegistry()` + `buildMcpResourceRegistry({ strategies })` — the SAME strategy registry instance, so `labre://methods` describes the catalogue this process will actually resolve against, fixtures included and declared `mock`. A costume declaration that names a prompt the registry does not hold fails the boot.
4. Boots the HTTP server on `LABRE_HTTP_PORT` (default `6767`).
5. Logs the registered tools, prompts, resources and strategy methodIds.

The `.mcp.json` at the repo root may declare the labre-mcp server either over HTTP (`"type": "http"`, `"url": "http://127.0.0.1:6767/mcp"` — Claude Code connects to a running daemon) or over stdio (`{ "command": "npx", "args": ["-y", "labre-mcp"] }` — Claude Code spawns `src/mcp/labre-stdio.mts`, the published `bin`). Both composition roots build the SAME six tools and the SAME costume (ARCH-27 / ARCH-28), so the surface is identical — asserted across both wires in [`costume-over-the-wire.test.mts`](../../src/mcp/costume-over-the-wire.test.mts).

## Configuration

The daemon reads the port from `LABRE_HTTP_PORT` (default `6767`) and the bind address from `LABRE_HTTP_HOST` (default `127.0.0.1`, loopback-only). Production deployments behind a PaaS router set `LABRE_HTTP_HOST=0.0.0.0`; a local daemon stays loopback-only unless explicitly opted in.

### Ops config endpoint (`GET /config/llm`)

Opt-in, gated by `LABRE_MCP_ADMIN_TOKEN` — a **shared ops secret** held by both the daemon and its sole consumer, the Labre admin console (Framework-MCP section). This is a server-to-server bearer, distinct from the per-user auth on `/mcp` (JWT / `lab_` keys). Unset → the route returns `503` (feature disabled); header missing or mismatched → `401`. On success it returns the config resolved by `loadLLMConfig()` — `{ defaultProvider, providers, strategies }` — augmented with a per-provider `hasKey = Boolean(process.env[apiKeyEnv ?? authEnv])`. The config only ever names env vars, so no secret value is read or emitted; `hasKey` is a boolean ops signal only.

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
      "domain": "wardley",
      "userPrompt": "decarbonise the ULM 412 H production line"
    }
  }
}
```

If `_context` is missing, the daemon falls back to dev-mode placeholders (`projectId = "default"`, `projectRoot = process.cwd()`). V3 SaaS will reject context-less requests at the auth middleware.

`userPrompt` (optional) carries the human user's **original, verbatim prompt** — the request as the person phrased it, not the calling agent's structured reformulation. It is ambient and user-supplied (the daemon never derives or enriches it), so any strategy can judge an agent's extraction against the original intent (e.g. `purpose:generate` stamps it into the study Context it emits, and `purpose:audit-purpose-quality` shows it as unstructured data). It is **never forwarded to telemetry** (metadata-only) and, like the rest of the context, only lands in the local run artifact.

**Rule**: tool handlers must not read `process.cwd()` or `process.env.X` at runtime. The boot-time `process.cwd()` is captured once and exposed only as the default `projectRoot`. Per-request paths are resolved against `context.projectRoot`.

## Auth middleware

V1 ships [`noopAuthMiddleware`](../../src/transport/auth-middleware.mts) which passes context through untouched. The handler chain is:

```ts
// transport: the auth door returns BOTH natures
const authenticated = await auth.authenticate(httpHeaders, contextFromBody);
// dispatch: the seam — the credential stops here (ARCH-27, third cut)
const context = toBusinessContext(authenticated);
```

Since ARCH-27 the middlewares return an `AuthenticatedContext` (`src/transport/auth-context.mts`): the business context with `userId` stamped on it, plus an `auth` object carrying the role, the verified bearer and the issuer provenance. `dispatch` strips that object before calling a handler, so no tool, listener or strategy can see a credential. Never add a credential field to `RequestContext`.

Real implementations (Supabase / OIDC JWKS / `lab_` API keys) are selected at boot from `LABRE_AUTH`; `noopAuthMiddleware` is the local-dev and stdio default. No tool handler changes either way.

## OAuth resource-server role (discovery only)

The daemon can act as an OAuth 2.0 **protected resource** for clients that only speak OAuth (claude.ai custom connectors). It stays a *resource* server — it validates bearer tokens via the auth middleware (JWKS in `oidc`/`supabase` mode) but **never mints them**. The authorization server (authorize / token / registration / consent) lives in the **labre app**, on a different origin — the MCP authorization spec explicitly allows AS and RS to be separate.

When `LABRE_OAUTH_RESOURCE` + `LABRE_OAUTH_AUTH_SERVER` are set (opt-in), the daemon:

1. serves `GET /.well-known/oauth-protected-resource` → `{ resource, authorization_servers: [<labre AS>] }` (RFC 9728);
2. stamps a `WWW-Authenticate: Bearer resource_metadata="<…/.well-known/oauth-protected-resource>"` header on every `401`, so the client discovers the AS.

Discovery flow: client → daemon `/mcp` (401 + WWW-Authenticate) → daemon well-known (finds the labre AS) → labre `/authorize` + `/token` (labre reuses the Supabase session, issues a labre-signed JWT) → daemon `/mcp` with that JWT (validated via labre's JWKS, `LABRE_AUTH=oidc`). Unset → no discovery surface. The labre-side AS is a separate build (labre repo).

**Explicit auth doors (`LABRE_AUTH` list).** `LABRE_AUTH` is a comma-separated list of the credential families the daemon accepts — `supabase`, `oidc`, `api-key` (see `auth-modes.mts`); every door is named, nothing rides implicitly. For the connector the daemon runs `LABRE_AUTH=oidc,api-key` pointed at the labre AS JWKS: one JWT issuer plus `lab_` personal keys (validated by RPC, not the JWT verifier). Listing `supabase,oidc` opens both JWT populations on one instance (per-`iss` routing, `multi-issuer-auth.mts`); only `supabase` tokens pass Supabase RLS (remote bundles), `oidc`/`api-key` do not. Only doors in the list are open, so `oidc` alone means "no static secrets" and `api-key` alone means "keys only".

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

For an end-to-end tool call, see [`http-transport.test.mts`](../../src/mcp/http-transport.test.mts).
