# labre-mcp

An [MCP](https://modelcontextprotocol.io) server for applying strategy **practice frameworks** — Wardley Maps first (value chain, evolution, climates, doctrines, the full study cycle). It exposes a small set of MCP tools backed by a pluggable **strategy registry** orchestrated by a **recipe runner**.

It runs as a local server that an MCP client — Claude Code / the Claude Agent SDK, or any MCP-capable client — launches over **stdio**. An HTTP daemon transport is also available (SaaS-ready by design).

## Requirements

- **Node.js ≥ 20**
- An **LLM provider** configured via `llm.config.json` (see [LLM configuration](#llm-configuration)). Most tools call an LLM; without a provider they degrade rather than crash, but produce no analysis.

## Install & use with Claude Code (stdio)

Add the server to your project's `.mcp.json` (or `~/.claude.json`). Claude Code spawns the process itself — there is no daemon to keep running:

```json
{
  "mcpServers": {
    "labre-mcp": {
      "command": "npx",
      "args": ["-y", "@formicoidea/labre-mcp"],
      "env": {
        "WARDLEY_LLM_CONFIG": "C:\\path\\to\\your\\llm.config.json"
      }
    }
  }
}
```

> **Windows note:** if `npx` fails to start the server, wrap it as `"command": "cmd"`, `"args": ["/c", "npx", "-y", "@formicoidea/labre-mcp"]`.

The `WARDLEY_LLM_CONFIG` env var is optional — if omitted, the server looks for `llm.config.json` in the client's working directory (your workspace root).

## Tools

| Tool | Purpose |
|---|---|
| `estimateEvolution` | Estimate the Wardley evolution position of a component (runs the `estimate-component-evolution` recipe). |
| `runCommand` | Invoke a single strategy directly by its 5-segment methodId → `CommandResult` + JSON-labre envelope. |
| `runRecipe` | Run a multi-step recipe by `<domain>:<tool>:<name>` reference → JSON-labre envelope + final AST + artifact path. |
| `__ping__` | Smoke tool — echoes its input. Validates the transport. |

The full methodId catalogue lives in [docs/architecture/ast-schema.md](docs/architecture/ast-schema.md); recipes in [docs/architecture/recipes.md](docs/architecture/recipes.md).

## LLM configuration

Copy [`llm.config.example.json`](llm.config.example.json) to `llm.config.json` and point `WARDLEY_LLM_CONFIG` at it (or place it in your workspace root). Three provider kinds are supported:

- `agent-sdk` — the Claude Agent SDK (`claude`).
- `http-api` — an OpenAI-compatible gateway (e.g. OpenCode/Kimi with logprobs).
- `copilot-sdk` — GitHub Copilot.

Per-strategy provider/model/effort overrides are declared under `strategies` in the same file.

### Optional capabilities

Some strategies use external services and degrade gracefully when their config is absent:

- **BigQuery patent analysis** (CPC evolution): `BIGQUERY_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`.
- **Web search** (Agent SDK): `ANTHROPIC_API_KEY`.

## Artifacts

Each recipe run writes a verbose, analysis-ready JSON artifact to `~/.labre-mcp/runs/<projectId>/<runId>.json`.

## HTTP daemon (alternative transport)

For local development or a SaaS-style deployment, the server can run as an HTTP daemon instead of stdio:

```bash
npm run build
npm run mcp:prod          # node dist/core/transport/labre-daemon.mjs
```

It listens on `127.0.0.1:6767` (override with `LABRE_HTTP_PORT`). Point the client at it with:

```json
{ "mcpServers": { "labre-mcp": { "type": "http", "url": "http://127.0.0.1:6767/mcp" } } }
```

See [docs/architecture/transport.md](docs/architecture/transport.md) for the transport model.

### Secured remote deployment (optional)

The daemon can run as a stateless, authenticated server. All features below are
opt-in via environment variables read **at boot only**; without them the daemon
behaves exactly like the local dev setup above. The stdio transport is never
affected.

| Variable | Effect |
|---|---|
| `LABRE_AUTH=supabase` | Every `POST /mcp` requires a Supabase JWT (`Authorization: Bearer`), verified against the project JWKS. Fail-closed: invalid/missing token → HTTP 401 (JSON-RPC `-32001`). Requires `SUPABASE_URL`. |
| `SUPABASE_URL` | Supabase project URL (JWKS endpoint derivation + bundle source). |
| `SUPABASE_JWT_AUD` | Expected `aud` claim (default `authenticated`). |
| `SUPABASE_ANON_KEY` | Enables the remote strategy-bundle source: declarative bundles (recipes + prompts, no code) published by the labre admin are fetched lazily **with the caller's own token** (RLS authorizes; the daemon holds no privileged credential) and verified file-by-file against their recorded sha256 before registration. |
| `LABRE_BUNDLES_TTL_S` | Bundle refresh throttle in seconds (default 300). |
| `POSTHOG_API_KEY` | Enables recipe rollout flags (`mcp-recipe-<domain>-<tool>-<name>`, fail-open) and metadata-only run telemetry (`mcp_boot`, `mcp_run_end`, `mcp_step_error` — never payloads or prompts). |
| `POSTHOG_HOST` | PostHog ingestion host (default US cloud). |

Secrets never ship with this package and are never required by the stdio
transport. The anon key is Supabase's public client key; the service-role key
is never used by this server.

## Development

```bash
npm install
npm run mcp:stdio         # stdio server via tsx (dev)
npm run mcp               # HTTP daemon via tsx (dev)
npm run typecheck
npm run test              # unit tests (some integration tests call real LLMs — see AGENT.md)
```

Architecture and decision records are under [docs/architecture/](docs/architecture/) — start with [ast-schema.md](docs/architecture/ast-schema.md) and [decisions.md](docs/architecture/decisions.md).

## License

ISC
