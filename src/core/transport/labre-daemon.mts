// Daemon entrypoint for labre-mcp HTTP transport (ARCH-14).
// Boots the HTTP server on the configured port AND the strategy registry
// (ARCH-03). The strategy registry is populated by importing each
// framework's `registry.mts`, which calls `registerXxxStrategies(reg)`.
// MCP tool handlers consume this registry via the recipe runner to
// resolve methodIds at call time.

import { fileURLToPath } from "node:url";
import type { ToolRegistry } from "./mcp-handler.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { startHttpServer, type OnAuthenticatedHook } from "./http-server.mjs";
import { buildSupabaseAuthMiddleware, tryExtractBearerToken } from "./supabase-auth.mjs";
import { buildJwksAuthMiddleware } from "./jwks-auth.mjs";
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
// them at request time only). Modes fail closed on missing config:
//   supabase — Supabase preset; requires SUPABASE_URL.
//   oidc     — any OIDC IdP (Okta, Auth0, Clerk, Entra, Keycloak, ...);
//              requires AUTH_JWKS_URL + AUTH_AUDIENCE; optional AUTH_ISSUER,
//              AUTH_ROLE_CLAIM. GitHub login is federated THROUGH such an IdP
//              (GitHub's own user tokens are opaque, not JWKS-verifiable).
//   none/unset — local noop.
function selectAuthMiddleware(): AuthMiddleware | undefined {
  const mode = process.env.LABRE_AUTH;
  if (mode === undefined || mode === "" || mode === "none") return undefined;
  if (mode === "supabase") {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      throw new Error(
        'LABRE_AUTH="supabase" requires SUPABASE_URL to be set (fail-closed: refusing to boot unauthenticated)',
      );
    }
    return buildSupabaseAuthMiddleware({
      supabaseUrl,
      audience: process.env.SUPABASE_JWT_AUD,
    });
  }
  if (mode === "oidc") {
    const jwksUrl = process.env.AUTH_JWKS_URL;
    const audience = process.env.AUTH_AUDIENCE;
    if (!jwksUrl || !audience) {
      throw new Error(
        'LABRE_AUTH="oidc" requires AUTH_JWKS_URL and AUTH_AUDIENCE to be set (fail-closed: refusing to boot unauthenticated)',
      );
    }
    return buildJwksAuthMiddleware({
      jwksUrl,
      audience,
      issuer: process.env.AUTH_ISSUER,
      roleClaim: process.env.AUTH_ROLE_CLAIM,
    });
  }
  throw new Error(`Invalid LABRE_AUTH: "${mode}" (expected "supabase", "oidc" or "none")`);
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
    return { bootLine: "off (requires LABRE_AUTH=supabase)" };
  }
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    return { bootLine: "off (SUPABASE_ANON_KEY not set)" };
  }
  // selectAuthMiddleware already guaranteed SUPABASE_URL under supabase mode.
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
    const token = tryExtractBearerToken(headers);
    if (token) await source.refreshIfStale(token);
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
  // Remote bundles are a Supabase feature (RLS + storage): only the supabase
  // auth mode enables them — an oidc-mode caller token would mean nothing to
  // the Supabase RLS layer.
  const bundles = selectBundleRefreshHook(process.env.LABRE_AUTH === "supabase");

  // LABRE_HTTP_HOST: "0.0.0.0" behind a PaaS router; default
  // stays loopback so a local daemon is never exposed by accident.
  const hostname = process.env.LABRE_HTTP_HOST || "127.0.0.1";
  const server = await startHttpServer({ port, hostname, tools, auth, onAuthenticated: bundles.hook });

  process.stderr.write(
    `[labre-mcp] HTTP server listening on http://${hostname}:${server.port} (POST /mcp)\n`,
  );
  process.stderr.write(
    `[labre-mcp] Auth: ${auth ? `${process.env.LABRE_AUTH} JWT (JWKS)` : "none (local dev)"}\n`,
  );
  process.stderr.write(`[labre-mcp] Remote strategy bundles: ${bundles.bootLine}\n`);
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
      auth: auth ? "supabase" : "none",
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
