# Remote administration & secured consumption — interface contracts

Design contracts for the remote story: administration (bundle upload, flags,
permissions) through the labre-admin back-office, secured consumption through
the labre-mcp HTTP daemon. Two repos are involved: `labre-mcp` (this one) and
`labre` (Supabase migrations + admin SPA/API).

## Statelessness principle

The MCP writes **nothing durable**. All durable state (bundles, permissions,
flags) lives in Supabase / PostHog and is written exclusively by the admin API.
The daemon reads at boot + TTL refresh into a disposable in-memory cache;
a crashed or scaled instance reloads at boot. Run artifacts are returned to the
caller or pushed to Supabase Storage under the caller's identity (RLS) — never
kept on the server. The stdio transport is unchanged: local files, no network.

## Responsibility matrix

| Interface | Role | Security boundary |
|---|---|---|
| Supabase (Auth + DB + Storage) | IdP (single identity source) + RLS as last line of defense | RLS: `strategy_bundles` read = authenticated & `enabled`, write = service-role only |
| labre-admin SPA (browser) | Admin UX; client-side zod validation = fast feedback only | none (cosmetic gate) |
| labre-admin `api/*` (Vercel) | **The only write door.** `requireAdmin()` (JWT + server-side role check), re-validates manifests (zod), computes per-file sha256, writes via service-role, journals to `admin_audit` | requireAdmin + service-role secrets server-side only |
| labre-mcp HTTP daemon | **The only consumption door.** AuthN: JWKS-verified Supabase JWT → 401 pre-dispatch. AuthZ: `userId`/claims in RequestContext; flags; data access with the *user's* token (RLS applies, no privilege elevation — the daemon never holds the service-role key). Integrity: treats Supabase as untrusted input — zod + sha256 re-verification on every bundle load, `Degradable` on failure | JWKS + flags + hash verification |
| labre-mcp stdio | Local dev. Trust boundary = the spawning process (noop auth) | the parent process |

Write path and read path meet only in Supabase, under RLS, with the per-file
sha256 recorded by the admin API acting as a tamper-evidence seal: bucket
compromise alone cannot inject a bundle (the row is service-role-writable only).

## Contract 1 — Supabase auth middleware (labre-mcp)

- Dependency: `jose` (JWT + JWKS; security path, never hand-rolled).
- `RequestContext` gains optional `auth: { userId: string; role?: string }`.
- `buildSupabaseAuthMiddleware({ supabaseUrl, audience = "authenticated", jwks? })`
  implements the existing `AuthMiddleware` interface. `jwks` is injectable for
  tests; default `createRemoteJWKSet(<SUPABASE_URL>/auth/v1/.well-known/jwks.json)`.
- Fail closed: missing/expired/bad-audience/bad-signature token →
  `AuthenticationError` → HTTP 401 with JSON-RPC error `Unauthorized = -32001`
  (no internal reason leaked). Auth runs BEFORE dispatch; the enriched context
  is what dispatch receives.
- Boot selection (`labre-daemon.mts` only): `LABRE_AUTH` is a comma-separated
  list of doors (`supabase`, `oidc`, `api-key` — see `auth-modes.mts`). Each
  listed door fails closed on its own env: `supabase` needs `SUPABASE_URL`
  (optional `SUPABASE_JWT_AUD`); `oidc` needs `AUTH_JWKS_URL` + `AUTH_AUDIENCE`;
  `api-key` needs `SUPABASE_URL` + `SUPABASE_ANON_KEY`. Unset, `none` or empty →
  noop middleware (local dev). Env reads at boot are the allowed exception;
  never at request time.

## Contract 2 — Strategy bundle manifest v0 (labre-mcp)

A bundle is **data only** — it composes shipped primitives; it never ships code.

```
<bundle-root>/
  manifest.json
  recipe.json                                  # exactly one recipe in v0
  prompts/<strategyId>/<name>.system.md        # optional, split pairs only
  prompts/<strategyId>/<name>.user.md
```

`manifest.json` (zod: `src/schemas/strategy-bundle.schema.mts`, exported to
consumers via the `@formicoidea/labre-mcp/schemas` subpath):

- `schemaVersion: "0.1"`, `slug` (kebab), `version` (semver), `description`
- `permissions: ("llm" | "bigquery" | "network" | "render")[]`
- `prompts?: Record<strategyId, promptName[]>`

Load-time static checks (loader throws; the caller degrades): manifest and
recipe zod-valid (recipe reuses the existing recipe schema), every declared
prompt pair present with an invariant system file (no `{{var}}`), step
methodIds match the 5-segment grammar, prompt pairs require the `llm`
permission, recipe `name === slug`, no collision with shipped recipe names.

<!-- ponytail: permission enforcement is static (declared at load), not a
runtime capability interception — upgrade to a runtime capability map if
bundles ever gain broader powers. -->

## Contract 3 — strategy_bundles storage (labre)

Migration `20260707000100_strategy_bundles.sql`:

- `public.strategy_bundles`: `id`, `slug`, `version` (unique slug+version),
  `manifest jsonb`, `files jsonb` (`[{ path, sha256 }]` — per-file integrity,
  no archive format, zero unzip dependency on either side), `storage_prefix`,
  `enabled` (default false), `created_by → auth.users`, timestamps + trigger.
- RLS: authenticated SELECT where `enabled = true`; **no write policies**
  (service-role only, i.e. the admin API).
- Private Storage bucket `strategy-bundles`: authenticated SELECT, no write
  policies.

## Read model (wave 2, as built)

**Zero daemon credentials.** The daemon holds no Supabase key beyond the
public anon key — never the service-role key, no machine account. Bundles are
fetched **lazily on the first authenticated request**, with the CALLER's
bearer token (short-lived per-refresh client; the token is never stored on the
context, logged, or kept beyond the refresh). RLS authorizes the read.

Per call: memory only, zero DB queries. Refresh: throttled by TTL
(`LABRE_BUNDLES_TTL_S`, default 300 s) on last *attempt* (an outage costs one
degraded try per window); change probe = one `max(updated_at)` + `count` query
(count catches disabled-bundle disappearance). Swap is atomic (no `await`
between reset and re-registration). Total failure → stale-over-broken. The
row's `manifest` jsonb is ignored: only the sha256-sealed downloaded
`manifest.json` is trusted. `storage_prefix` is **bucket-internal**
(`<slug>/<version>/`) — the bucket name is a constant, never part of the path.

Supabase client via dynamic import — stdio never loads it. Bundle prompts are
**live**: each accepted bundle registers its prompt pairs alongside its recipe,
and a run of that recipe layers them over the shipped prompts through a
run-scoped AsyncLocalStorage store (`src/lib/prompts/override-context.mts`) —
never by mutating the global prompt-registry cache, so concurrent callers are
isolated. Constraints: a bundle supplies prompt TEXT only (the parser always
comes from the shipped entry — trust boundary), and only shipped template-kind
prompts are overridable (`assertBundlePromptsOverridable`; a bundle failing the
check is rejected like any other bad bundle). A same-ref user recipe never
inherits a bundle's prompts (identity-checked in `getBundlePrompts`).

## Contract 4 — PostHog flags & telemetry (labre-mcp, wave 2)

- Key convention `mcp-recipe-<domain>-<tool>-<name>`; gate on the runRecipe
  tool with `context.auth?.userId ?? "anonymous"`. **Fail-open** (undefined
  flag, PostHog outage, or no config → allowed): flags are rollout controls,
  not a security boundary — auth is.
- **Prompt experiments (A/B)**: multivariate flags keyed
  `mcp-prompt-<strategyId>`. The flag's variant key **is** the prompt name by
  convention (labre-admin creates variants matching prompt names). Assignment
  happens once per run via `getAllFlags` with the same distinctId as the gate;
  the run's `getPrompt(strategy)` redirects `default` to the assigned variant
  (bundle override first, then shipped entry; nonexistent variant → silent
  fallback to `default`, fail-open). Explicit non-default prompt names are
  never substituted.
- Telemetry: `mcp_boot`, `mcp_run_end`, `mcp_step_error` — metadata and
  numbers only (recipeRunId, stepId, methodId, durationMs, degraded), never
  payloads, prompts or user content. Fire-and-forget; flush on shutdown.
  Experiment/performance properties:
  - `$feature/mcp-prompt-<strategyId>: <variant>` on both run-end and
    step-error events (PostHog-native experiment attribution).
  - On `mcp_run_end` only: `llmCalls`, `inputTokens`, `outputTokens` (token
    sums omitted when the provider exposes none — copilot-sdk counts calls
    only) and `quality_<name>` — finite-numeric envelope signals harvested at
    run-end (capped at 20 keys, names sanitized to `[a-zA-Z0-9_]`). Numbers
    exclusively; string signal values are never forwarded.
- `posthog-node` via dynamic import; `POSTHOG_API_KEY` absent → fully off.
  There is no global event bus (per-run buses, ARCH-10): boot installs the
  instance, each run attaches the forwarder to its own bus.
