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
- Boot selection (`labre-daemon.mts` only): `LABRE_AUTH=supabase` requires
  `SUPABASE_URL` (boot fails if absent); optional `SUPABASE_JWT_AUD`. Unset or
  `none` → noop middleware (local dev). Env reads at boot are the allowed
  exception; never at request time.

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

## Read model (phase 3, for reference)

Boot: fetch enabled bundles → zod + sha256 → in-memory registry. Per call:
memory only, zero DB queries. Refresh: one lightweight `max(updated_at)` probe
per TTL window. Supabase client loaded via dynamic import so the stdio
transport never pays for it.
