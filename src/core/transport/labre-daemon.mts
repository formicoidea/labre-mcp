// Daemon entrypoint for labre-mcp HTTP transport (ARCH-14).
// Boots the HTTP server on the configured port AND the strategy registry
// (ARCH-03). The strategy registry is populated by importing each
// framework's `registry.mts`, which calls `registerXxxStrategies(reg)`.
// MCP tool handlers consume this registry via the recipe runner to
// resolve methodIds at call time.

import { fileURLToPath } from "node:url";
import type { ToolRegistry } from "./mcp-handler.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { startHttpServer, type OnAuthenticatedHook, type OAuthResourceConfig } from "./http-server.mjs";
import { buildSupabaseAuthMiddleware, tryExtractBearerToken } from "./supabase-auth.mjs";
import { buildJwksAuthMiddleware } from "./jwks-auth.mjs";
import { buildMultiIssuerAuthMiddleware } from "./multi-issuer-auth.mjs";
import { buildApiKeyAuthMiddleware, routeBearerAuth, API_KEY_PREFIX } from "./api-key-auth.mjs";
import { registerBootHealthChecks } from "./boot-health-checks.mjs";
import { runAllHealthChecks } from "#lib/degradation/index.mjs";
import { buildSupabaseBundleSource } from "#lib/bundles/supabase-bundle-source.mjs";
import { SHIPPED_ROOT } from "#mcp/shipped-root.mjs";
import type { PostHogFlags } from "#lib/flags/posthog.mjs";
import { setPostHogFlags } from "#lib/flags/state.mjs";

// Re-export so existing callers (tests, downstream tooling) can keep
// importing `buildStrategyRegistry` / `buildBootRegistry` from this module
// without churn. The tool registry is now built in the transport-agnostic
// boot-tool-registry module, shared with the stdio entrypoint.
export { buildStrategyRegistry } from "./strategy-registry-boot.mjs";
export { buildBootRegistry } from "./boot-tool-registry.mjs";
import { buildStrategyRegistry } from "./strategy-registry-boot.mjs";
import { buildBootRegistry } from "./boot-tool-registry.mjs";

const DEFAULT_PORT = 6767;

function readPort(): number {
  const raw = process.env.LABRE_HTTP_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid LABRE_HTTP_PORT: "${raw}" (expected integer 1-65535)`);
  }
  return parsed;
}

// lab_ personal API keys (created in the labre UI) are validated against the
// labre_mcp.validate_api_key RPC with the public anon key — independent of the
// JWT issuer, so they ride ALONGSIDE any JWT mode (supabase OR oidc). Wraps the
// given JWT middleware to route lab_ bearers to the API-key path; without
// SUPABASE_URL + SUPABASE_ANON_KEY, lab_ bearers just fall through to the JWT
// middleware and get its 401 — fail closed, never open.
export function withApiKeys(jwt: AuthMiddleware): AuthMiddleware {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return jwt;
  return routeBearerAuth(jwt, buildApiKeyAuthMiddleware({ supabaseUrl, anonKey }));
}

// Boot-time auth selection (env reads at boot are allowed — ARCH-15 forbids
// them at request time only). Modes fail closed on missing config; lab_ API
// keys ride alongside EITHER JWT mode (see withApiKeys):
//   oidc     — any OIDC IdP verifiable by JWKS (Okta, Auth0, Clerk, Entra,
//              Keycloak, AND the labre OAuth AS that fronts the framework-mcp
//              connector); requires AUTH_JWKS_URL + AUTH_AUDIENCE; optional
//              AUTH_ISSUER, AUTH_ROLE_CLAIM. This is the mode for the OAuth
//              connector — the daemon validates AS-issued JWTs via the AS JWKS.
//   supabase — Supabase preset (JWKS derived from SUPABASE_URL). Legacy path
//              for raw Supabase session tokens; NOT used by the OAuth connector.
//   multi    — BOTH JWT populations on one instance (issue #33): each bearer
//              is routed on its iss claim to the matching issuer config
//              (Supabase = {SUPABASE_URL}/auth/v1; OIDC = AUTH_JWKS_URL +
//              AUTH_AUDIENCE, optional AUTH_ISSUER/AUTH_ROLE_CLAIM). Requires
//              the UNION of both modes' env; unknown iss → 401, no fallback.
//   none/unset — local noop.
// Exported for the boot fail-closed matrix tests (same pattern as withApiKeys).
export function selectAuthMiddleware(): AuthMiddleware | undefined {
  const mode = process.env.LABRE_AUTH;
  if (mode === undefined || mode === "" || mode === "none") return undefined;
  if (mode === "supabase") {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      throw new Error(
        'LABRE_AUTH="supabase" requires SUPABASE_URL to be set (fail-closed: refusing to boot unauthenticated)',
      );
    }
    return withApiKeys(
      buildSupabaseAuthMiddleware({ supabaseUrl, audience: process.env.SUPABASE_JWT_AUD }),
    );
  }
  if (mode === "oidc") {
    const jwksUrl = process.env.AUTH_JWKS_URL;
    const audience = process.env.AUTH_AUDIENCE;
    if (!jwksUrl || !audience) {
      throw new Error(
        'LABRE_AUTH="oidc" requires AUTH_JWKS_URL and AUTH_AUDIENCE to be set (fail-closed: refusing to boot unauthenticated)',
      );
    }
    return withApiKeys(
      buildJwksAuthMiddleware({
        jwksUrl,
        audience,
        issuer: process.env.AUTH_ISSUER,
        roleClaim: process.env.AUTH_ROLE_CLAIM,
      }),
    );
  }
  if (mode === "multi") {
    // The union of both single modes' requirements — every activated issuer
    // brings its own vars, and ANY missing one refuses the boot (fail-closed,
    // same posture as the single modes above).
    const supabaseUrl = process.env.SUPABASE_URL;
    const jwksUrl = process.env.AUTH_JWKS_URL;
    const audience = process.env.AUTH_AUDIENCE;
    const missing = [
      ...(supabaseUrl ? [] : ["SUPABASE_URL"]),
      ...(jwksUrl ? [] : ["AUTH_JWKS_URL"]),
      ...(audience ? [] : ["AUTH_AUDIENCE"]),
    ];
    if (!supabaseUrl || !jwksUrl || !audience) {
      throw new Error(
        `LABRE_AUTH="multi" requires SUPABASE_URL, AUTH_JWKS_URL and AUTH_AUDIENCE to be set ` +
          `(missing: ${missing.join(", ")}) (fail-closed: refusing to boot unauthenticated)`,
      );
    }
    return withApiKeys(
      buildMultiIssuerAuthMiddleware({
        supabase: { supabaseUrl, audience: process.env.SUPABASE_JWT_AUD },
        oidc: {
          jwksUrl,
          audience,
          issuer: process.env.AUTH_ISSUER,
          roleClaim: process.env.AUTH_ROLE_CLAIM,
        },
      }),
    );
  }
  throw new Error(`Invalid LABRE_AUTH: "${mode}" (expected "supabase", "oidc", "multi" or "none")`);
}

// OAuth protected-resource discovery config (env at boot only — ARCH-15).
// Both vars required together; either missing → discovery off (the daemon
// stays a plain-401 resource server, static bearers unaffected). URLs are
// validated at boot so a typo fails fast instead of serving broken metadata.
function readOAuthConfig(): OAuthResourceConfig | undefined {
  const resource = process.env.LABRE_OAUTH_RESOURCE;
  const authServer = process.env.LABRE_OAUTH_AUTH_SERVER;
  if (!resource && !authServer) return undefined;
  if (!resource || !authServer) {
    throw new Error(
      "OAuth discovery requires BOTH LABRE_OAUTH_RESOURCE and LABRE_OAUTH_AUTH_SERVER (or neither)",
    );
  }
  for (const [name, value] of [
    ["LABRE_OAUTH_RESOURCE", resource],
    ["LABRE_OAUTH_AUTH_SERVER", authServer],
  ] as const) {
    try {
      new URL(value);
    } catch {
      throw new Error(`Invalid ${name}: "${value}" (expected an absolute URL)`);
    }
  }
  return { resource, authServer };
}

function readBundlesTtlSeconds(): number | undefined {
  const raw = process.env.LABRE_BUNDLES_TTL_S;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid LABRE_BUNDLES_TTL_S: "${raw}" (expected non-negative integer seconds)`);
  }
  return parsed;
}

// Remote strategy bundles ride the supabase auth mode: they refresh with the
// CALLER's bearer token (RLS authorizes) — the daemon itself holds no Supabase
// credential beyond the public anon key. Without the anon key the source is
// simply off and the daemon serves shipped/user recipes only.
function selectBundleRefreshHook(
  authed: boolean,
): { hook?: OnAuthenticatedHook; bootLine: string } {
  if (!authed) {
    return { bootLine: "off (requires LABRE_AUTH=supabase or multi)" };
  }
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    return { bootLine: "off (SUPABASE_ANON_KEY not set)" };
  }
  // selectAuthMiddleware already guaranteed SUPABASE_URL under the supabase
  // and multi modes (the only ones that reach this branch).
  const supabaseUrl = process.env.SUPABASE_URL as string;
  const ttlSeconds = readBundlesTtlSeconds();
  const source = buildSupabaseBundleSource({
    supabaseUrl,
    anonKey,
    ttlSeconds,
    shippedRoot: SHIPPED_ROOT,
  });
  const hook: OnAuthenticatedHook = async (headers) => {
    // The token is read from the (already authenticated) request headers and
    // handed straight to the refresh — never stored on the context or logged.
    // lab_ API keys are not JWTs: the bundle RLS layer cannot use them, so
    // those requests skip the refresh (bundles stay fresh via JWT callers).
    const token = tryExtractBearerToken(headers);
    if (token && !token.startsWith(API_KEY_PREFIX)) await source.refreshIfStale(token);
  };
  return { hook, bootLine: `on (lazy, TTL ${ttlSeconds ?? 300}s, caller-token RLS)` };
}

// Boot-time PostHog selection (env reads at boot only — same exception as
// auth). Absent POSTHOG_API_KEY → flags gate and telemetry fully disabled;
// `posthog-node` stays dynamically imported inside buildPostHog, so an
// unconfigured daemon (and the stdio transport, which never runs this file)
// never loads the package.
async function selectPostHog(): Promise<PostHogFlags | undefined> {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return undefined;
  const { buildPostHog } = await import("#lib/flags/posthog.mjs");
  return buildPostHog({ apiKey, host: process.env.POSTHOG_HOST });
}

async function main(): Promise<void> {
  const port = readPort();
  const auth = selectAuthMiddleware();
  const tools: ToolRegistry = buildBootRegistry();
  const strategies = buildStrategyRegistry();
  // Remote bundles are a Supabase feature (RLS + storage): only the modes
  // that admit Supabase JWTs enable them (supabase, and multi — issue #33).
  // An oidc caller token means nothing to the Supabase RLS layer; under multi
  // the refresh hook simply no-ops usefully for OIDC bearers (RLS refuses).
  const authMode = process.env.LABRE_AUTH;
  const bundles = selectBundleRefreshHook(authMode === "supabase" || authMode === "multi");

  // LABRE_HTTP_HOST: "0.0.0.0" behind a PaaS router; default
  // stays loopback so a local daemon is never exposed by accident.
  const hostname = process.env.LABRE_HTTP_HOST || "127.0.0.1";
  const oauth = readOAuthConfig();
  const server = await startHttpServer({ port, hostname, tools, auth, onAuthenticated: bundles.hook, oauth });

  process.stderr.write(
    `[labre-mcp] HTTP server listening on http://${hostname}:${server.port} (POST /mcp)\n`,
  );
  // lab_ keys ride alongside any JWT mode (withApiKeys), so this is no longer
  // supabase-specific — it's on whenever a JWT mode is active and the anon key
  // + URL are set.
  const apiKeysEnabled =
    !!auth && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY;
  // Honest boot line (issue #33): "multi" spells out both issuer families.
  const jwtLabel = authMode === "multi" ? "supabase+oidc" : authMode;
  process.stderr.write(
    `[labre-mcp] Auth: ${auth ? `${jwtLabel} JWT (JWKS)${apiKeysEnabled ? " + lab_ API keys" : ""}` : "none (local dev)"}\n`,
  );
  process.stderr.write(`[labre-mcp] Remote strategy bundles: ${bundles.bootLine}\n`);
  process.stderr.write(
    `[labre-mcp] OAuth discovery: ${oauth ? `on (resource=${oauth.resource}, AS=${oauth.authServer})` : "off (static bearer only)"}\n`,
  );
  process.stderr.write(
    `[labre-mcp] Tools registered: ${tools.list().map((t) => t.name).join(", ") || "(none)"}\n`,
  );
  process.stderr.write(
    `[labre-mcp] Strategies registered (${strategies.size()}):\n${strategies.list().map((id) => `  - ${id}`).join("\n")}\n`,
  );

  // PostHog feature flags + telemetry (daemon only, env at boot only).
  const posthog = await selectPostHog();
  if (posthog) {
    setPostHogFlags(posthog);
    // Metadata only — no payloads, no user content.
    posthog.capture("mcp_boot", "daemon", {
      port: server.port,
      // The actual mode (supabase | oidc | multi), not a hardcoded label.
      auth: auth ? authMode : "none",
      tools: tools.list().length,
      strategies: strategies.size(),
    });
  }
  process.stderr.write(
    `[labre-mcp] PostHog: ${posthog ? "enabled (recipe flags + telemetry)" : "disabled (POSTHOG_API_KEY not set — flags fail open, no telemetry)"}\n`,
  );

  // Boot health checks (config/env presence only — no network). Never blocks boot.
  registerBootHealthChecks();
  const healthEvents = await runAllHealthChecks();
  if (healthEvents.length === 0) {
    process.stderr.write("[labre-mcp] Health checks: all dependencies ready\n");
  } else {
    process.stderr.write(
      `[labre-mcp] Health checks — ${healthEvents.length} dependency(ies) degraded:\n${healthEvents
        .map((e) => `  - ${e.source}: ${e.reason}`)
        .join("\n")}\n`,
    );
  }

  const shutdown = async (signal: string) => {
    process.stderr.write(`[labre-mcp] Received ${signal}, shutting down\n`);
    await server.close();
    // Flush queued telemetry before exit; shutdown() swallows client errors.
    if (posthog) await posthog.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only run when executed as a script (not when imported by tests).
// fileURLToPath handles Windows/Unix path-encoding differences uniformly.
const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[labre-mcp] Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
