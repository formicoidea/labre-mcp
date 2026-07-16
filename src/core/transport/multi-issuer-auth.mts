// Multi-issuer JWT auth (issue #33): ONE instance accepts BOTH JWT
// populations — Supabase session tokens (the labre app, agentReply's RLS
// pass-through) AND a generic OIDC IdP's tokens (external MCP clients) — by
// routing each bearer on its `iss` claim to the matching single-issuer
// middleware. lab_ API keys are NOT handled here: the api-key door composes on
// top via routeBearerAuth in selectAuthMiddleware (see labre-daemon.mts).
//
// Design: pure COMPOSITION of the two existing middlewares, no forked
// validation logic. The iss claim is decoded WITHOUT verification — it is
// used ONLY to pick which issuer's config must verify the token; the full
// cryptographic verification (signature via that issuer's JWKS, exp/nbf,
// audience, issuer when configured) is delegated to the routed middleware.
// Each middleware instance owns its own remote JWKS resolver, so the JWKS
// cache is per-issuer by construction (no cross-pollution).
//
// Fail-closed routing (never a fallback to the other issuer):
//   - bearer is not a decodable JWT              → 401
//   - no `iss` claim                             → 401 (routing impossible)
//   - iss == {SUPABASE_URL}/auth/v1              → Supabase middleware ONLY
//   - AUTH_ISSUER configured and iss != it       → 401 (unknown issuer)
//   - anything else                              → OIDC middleware ONLY
//     (without a configured AUTH_ISSUER the OIDC population is defined by
//     the OIDC JWKS keys — identical trust model to today's single `oidc`
//     mode, where the issuer check is optional; an unknown issuer's token
//     cannot carry a valid signature and still gets its 401 there.)

import { decodeJwt } from "jose";
import type { RequestContext } from "../context/request-context.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { AuthenticationError } from "./auth-middleware.mjs";
import { buildJwksAuthMiddleware, extractBearerToken, type JwksAuthOptions } from "./jwks-auth.mjs";
import { buildSupabaseAuthMiddleware, type SupabaseAuthOptions } from "./supabase-auth.mjs";

export interface MultiIssuerAuthOptions {
  /** The Supabase issuer's config — same shape the single `supabase` mode
   *  builds. Its issuer is derived as `${supabaseUrl}/auth/v1` (what Supabase
   *  Auth stamps into the `iss` claim of every session token). */
  supabase: SupabaseAuthOptions;
  /** The OIDC issuer's config — same shape the single `oidc` mode builds.
   *  `issuer` (AUTH_ISSUER) is optional as today, but when set it also
   *  becomes the STRICT routing key: any other non-Supabase iss → 401
   *  without ever touching a JWKS. */
  oidc: Omit<JwksAuthOptions, "source">;
}

/** The `iss` claim Supabase Auth mints, derived from the project URL. */
// Trailing slashes are normalized away: a SUPABASE_URL written with one would
// otherwise derive an issuer with a double slash, never match the real iss,
// and silently route EVERY Supabase JWT to the OIDC branch — a total (if
// fail-closed) auth outage for the app population. Availability hardening.
export function supabaseIssuerOf(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

export function buildMultiIssuerAuthMiddleware(options: MultiIssuerAuthOptions): AuthMiddleware {
  const supabaseIssuer = supabaseIssuerOf(options.supabase.supabaseUrl);
  // Both delegates are the UNCHANGED single-issuer middlewares; they stamp
  // their own provenance (source 'supabase' / 'oidc') and thread the verified
  // raw bearer for RLS pass-through exactly as in single-issuer modes.
  const supabase = buildSupabaseAuthMiddleware(options.supabase);
  const oidc = buildJwksAuthMiddleware({ ...options.oidc, source: "oidc" });

  return {
    async authenticate(headers, context): Promise<RequestContext> {
      const token = extractBearerToken(headers);

      // Route on the UNVERIFIED iss claim only — never trust anything else
      // from the payload before the delegated jwtVerify has passed.
      let iss: unknown;
      try {
        iss = decodeJwt(token).iss;
      } catch {
        throw new AuthenticationError("bearer is not a decodable JWT (multi-issuer routing)");
      }
      if (typeof iss !== "string" || iss.length === 0) {
        throw new AuthenticationError("token has no iss claim (multi-issuer routing requires one)");
      }

      if (iss === supabaseIssuer) {
        // Supabase population: verified against the Supabase JWKS ONLY. A
        // failure there is final — never retried against the OIDC issuer.
        return supabase.authenticate(headers, context);
      }
      if (options.oidc.issuer !== undefined && iss !== options.oidc.issuer) {
        // Unknown issuer: fail closed before any JWKS is consulted. The
        // reason stays internal (the HTTP layer maps it to a generic 401).
        throw new AuthenticationError(`unknown token issuer "${iss}" (no matching JWKS)`);
      }
      // OIDC population: verified against the OIDC JWKS ONLY — same finality.
      return oidc.authenticate(headers, context);
    },
  };
}
