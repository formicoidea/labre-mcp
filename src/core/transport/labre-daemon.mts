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
import { parseAuthDoors } from "./auth-modes.mjs";
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

// Boot-time auth selection (env reads at boot are allowed — ARCH-15 forbids
// them at request time only). LABRE_AUTH is an explicit list of doors
// (auth-modes.mts); each listed door fails closed on its own missing env:
//   supabase — Supabase session JWTs (JWKS from SUPABASE_URL). The labre app's
//              population; the only source that reaches agent.reply's RLS.
//   oidc     — any OIDC IdP verifiable by JWKS (Okta, Auth0, Clerk, Entra,
//              Keycloak, AND the labre OAuth AS that fronts the framework-mcp
//              connector). Requires AUTH_JWKS_URL + AUTH_AUDIENCE; optional
//              AUTH_ISSUER, AUTH_ROLE_CLAIM.
//   api-key  — lab_ personal keys (created in the labre UI, validated by the
//              validate_api_key RPC — no JWT verifier). Requires SUPABASE_URL +
//              SUPABASE_ANON_KEY; now an EXPLICIT door, no longer an implicit
//              rider (PR #34 follow-up on issue #33).
// supabase+oidc together → per-iss routing (multi-issuer middleware); either
// JWT door alone → that single-issuer middleware. api-key composes on top via
// routeBearerAuth (lab_ bearers to the RPC path, the rest to the JWT door), or
// stands alone when it is the only door. Unknown iss / bad token → 401, never a
// silent fallback. Exported for the boot fail-closed matrix tests.
export function selectAuthMiddleware(): AuthMiddleware | undefined {
  const doors = parseAuthDoors();
  if (doors.size === 0) return undefined;

  const supabaseUrl = process.env.SUPABASE_URL;
  const jwksUrl = process.env.AUTH_JWKS_URL;
  const audience = process.env.AUTH_AUDIENCE;

  // Each JWT door validates its own env — the boot refuses (fail-closed) with
  // the exact door and missing var named, never a partial/unauthenticated boot.
  if (doors.has("supabase") && !supabaseUrl) {
    throw new Error(
      'LABRE_AUTH lists "supabase" but SUPABASE_URL is not set (fail-closed: refusing to boot unauthenticated)',
    );
  }
  if (doors.has("oidc") && (!jwksUrl || !audience)) {
    const missing = [...(jwksUrl ? [] : ["AUTH_JWKS_URL"]), ...(audience ? [] : ["AUTH_AUDIENCE"])];
    throw new Error(
      `LABRE_AUTH lists "oidc" but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set ` +
        `(fail-closed: refusing to boot unauthenticated)`,
    );
  }

  // Build the JWT layer from whichever JWT doors are open (0, 1 or 2 of them).
  let auth: AuthMiddleware | undefined;
  if (doors.has("supabase") && doors.has("oidc")) {
    auth = buildMultiIssuerAuthMiddleware({
      supabase: { supabaseUrl: supabaseUrl as string, audience: process.env.SUPABASE_JWT_AUD },
      oidc: {
        jwksUrl: jwksUrl as string,
        audience: audience as string,
        issuer: process.env.AUTH_ISSUER,
        roleClaim: process.env.AUTH_ROLE_CLAIM,
      },
    });
  } else if (doors.has("supabase")) {
    auth = buildSupabaseAuthMiddleware({
      supabaseUrl: supabaseUrl as string,
      audience: process.env.SUPABASE_JWT_AUD,
    });
  } else if (doors.has("oidc")) {
    auth = buildJwksAuthMiddleware({
      jwksUrl: jwksUrl as string,
      audience: audience as string,
      issuer: process.env.AUTH_ISSUER,
      roleClaim: process.env.AUTH_ROLE_CLAIM,
    });
  }

  // api-key door: lab_ keys are verified via the validate_api_key RPC, so this
  // door needs SUPABASE_URL + SUPABASE_ANON_KEY regardless of the JWT doors.
  if (doors.has("api-key")) {
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      const missing = [
        ...(supabaseUrl ? [] : ["SUPABASE_URL"]),
        ...(anonKey ? [] : ["SUPABASE_ANON_KEY"]),
      ];
      throw new Error(
        `LABRE_AUTH lists "api-key" but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set ` +
          `(fail-closed: refusing to boot unauthenticated)`,
      );
    }
    const apiKey = buildApiKeyAuthMiddleware({ supabaseUrl, anonKey });
    // Alongside a JWT door: route lab_ bearers to the RPC, the rest to the JWT
    // verifier. Alone: the api-key middleware IS the whole auth (a JWT-shaped
    // bearer gets its own "not an API key" 401 — fail-closed, never open).
    auth = auth ? routeBearerAuth(auth, apiKey) : apiKey;
  }

  return auth;
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
    return { bootLine: "off (requires supabase in LABRE_AUTH)" };
  }
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    return { bootLine: "off (SUPABASE_ANON_KEY not set)" };
  }
  // selectAuthMiddleware already guaranteed SUPABASE_URL whenever the supabase
  // door is open (the only case that reaches this branch).
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
  // Remote bundles are a Supabase feature (RLS + storage): enabled only when
  // the supabase door is open. An oidc/lab_ caller token means nothing to the
  // Supabase RLS layer; the refresh hook simply no-ops usefully for those.
  const doors = parseAuthDoors();
  const bundles = selectBundleRefreshHook(doors.has("supabase"));

  // LABRE_HTTP_HOST: "0.0.0.0" behind a PaaS router; default
  // stays loopback so a local daemon is never exposed by accident.
  const hostname = process.env.LABRE_HTTP_HOST || "127.0.0.1";
  const oauth = readOAuthConfig();
  const server = await startHttpServer({ port, hostname, tools, auth, onAuthenticated: bundles.hook, oauth });

  process.stderr.write(
    `[labre-mcp] HTTP server listening on http://${hostname}:${server.port} (POST /mcp)\n`,
  );
  // Honest boot line: name exactly the doors that are open (auth-modes.mts).
  const jwtNames = [
    doors.has("supabase") ? "supabase" : undefined,
    doors.has("oidc") ? "oidc" : undefined,
  ].filter(Boolean);
  const authParts = [
    jwtNames.length ? `${jwtNames.join("+")} JWT (JWKS)` : undefined,
    doors.has("api-key") ? "lab_ API keys" : undefined,
  ].filter(Boolean);
  process.stderr.write(
    `[labre-mcp] Auth: ${authParts.length ? authParts.join(" + ") : "none (local dev)"}\n`,
  );
  // Migration guard: lab_ keys used to ride implicitly whenever the anon key
  // was set. Under the explicit-list model they are OFF unless "api-key" is
  // listed — say so loudly instead of silently 401ing existing lab_ callers.
  if (auth && !doors.has("api-key") && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    process.stderr.write(
      `[labre-mcp] WARNING: SUPABASE_ANON_KEY is set but "api-key" is not in LABRE_AUTH — lab_ API keys are REFUSED. Add "api-key" to LABRE_AUTH to accept them.\n`,
    );
  }
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
      // The actual doors open, sorted so the same config always reports the
      // same string regardless of the env list's order (telemetry cardinality).
      auth: auth ? [...doors].sort().join(",") : "none",
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
