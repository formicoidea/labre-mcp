// Supabase preset over the generic JWKS middleware (jwks-auth.mts): derives
// the JWKS endpoint from the project URL and defaults the audience to
// Supabase's "authenticated". Everything else — extraction, verification,
// fail-closed semantics, context enrichment — is the provider-neutral core.
//
// The stdio transport stays unauthenticated (local, spawned by the client);
// only the daemon boot (labre-daemon.mts) wires auth middlewares.

import type { JWTVerifyGetKey } from "jose";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { buildJwksAuthMiddleware } from "./jwks-auth.mjs";

// Re-exported so existing importers (daemon hook, tests) keep working after
// the extraction of the generic core.
export { tryExtractBearerToken } from "./jwks-auth.mjs";

export interface SupabaseAuthOptions {
  /** Supabase project URL, e.g. https://xyzcompany.supabase.co */
  supabaseUrl: string;
  /** Expected `aud` claim. Supabase issues "authenticated" by default. */
  audience?: string;
  /** Key resolver — injectable for tests (createLocalJWKSet). Defaults to
   *  the remote Supabase JWKS endpoint. */
  jwks?: JWTVerifyGetKey;
}

const DEFAULT_AUDIENCE = "authenticated";

export function buildSupabaseAuthMiddleware(options: SupabaseAuthOptions): AuthMiddleware {
  return buildJwksAuthMiddleware({
    jwksUrl: `${options.supabaseUrl}/auth/v1/.well-known/jwks.json`,
    jwks: options.jwks,
    audience: options.audience ?? DEFAULT_AUDIENCE,
    // Supabase puts the Postgres role in a top-level `role` claim — the
    // generic default already reads it.
  });
}
