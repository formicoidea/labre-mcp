// Supabase JWT authentication middleware for the HTTP daemon (ARCH-14).
// Verifies `Authorization: Bearer <jwt>` against the Supabase project JWKS
// (asymmetric keys, e.g. ES256) via jose. Fail-closed: any verification
// problem throws AuthenticationError — the HTTP layer maps it to 401.
//
// The stdio transport stays unauthenticated (local, spawned by the client);
// only the daemon boot (labre-daemon.mts) wires this middleware.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { RequestContext } from "../context/request-context.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";

/** Thrown when a request cannot be authenticated. The `reason` is internal
 *  diagnostics only — the HTTP layer must never leak it to the caller. */
export class AuthenticationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AuthenticationError";
  }
}

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

function extractBearerToken(headers: Record<string, string>): string {
  // Header lookup is case-insensitive per RFC 9110; normalize keys.
  const raw = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  if (!raw) throw new AuthenticationError("missing authorization header");
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  if (!match) throw new AuthenticationError("malformed authorization header (expected Bearer token)");
  return match[1];
}

export function buildSupabaseAuthMiddleware(options: SupabaseAuthOptions): AuthMiddleware {
  const audience = options.audience ?? DEFAULT_AUDIENCE;
  const jwks =
    options.jwks ??
    createRemoteJWKSet(new URL(`${options.supabaseUrl}/auth/v1/.well-known/jwks.json`));

  return {
    async authenticate(headers, context): Promise<RequestContext> {
      const token = extractBearerToken(headers);

      let payload;
      try {
        // jwtVerify checks signature (via JWKS), exp/nbf, and audience.
        ({ payload } = await jwtVerify(token, jwks, { audience }));
      } catch (err) {
        // Fail closed: any verification error (bad signature, expired,
        // wrong audience, unknown kid, JWKS fetch failure, ...) → 401.
        throw new AuthenticationError(
          `token verification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new AuthenticationError("token has no subject (sub) claim");
      }

      const role = typeof payload.role === "string" ? payload.role : undefined;
      return { ...context, auth: { userId: payload.sub, role } };
    },
  };
}
