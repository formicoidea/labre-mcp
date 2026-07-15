// Generic OIDC resource-server middleware: `Authorization: Bearer <jwt>`
// verified against a JWKS endpoint via jose. This is the provider-neutral
// core — Okta, Auth0, Clerk, Entra, Keycloak and Supabase all issue JWTs
// verifiable this way; provider-specific modules (supabase-auth.mts) are thin
// presets over it. Fail-closed: any verification problem throws
// AuthenticationError — the HTTP layer maps it to a generic 401 that leaks
// neither the reason nor the provider.
//
// Deliberately NOT supported: providers whose user tokens are opaque
// (e.g. GitHub OAuth `gho_…` tokens have no JWKS). Front those through an
// IdP's social login (Supabase/Auth0/Clerk all federate GitHub) — the MCP
// then receives a normal IdP-signed JWT and this middleware just works.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthSource, RequestContext } from "../context/request-context.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { AuthenticationError } from "./auth-middleware.mjs";

export interface JwksAuthOptions {
  /** JWKS endpoint, e.g. https://<tenant>.okta.com/oauth2/default/v1/keys.
   *  Required unless `jwks` is injected. */
  jwksUrl?: string;
  /** Key resolver — injectable for tests (createLocalJWKSet). */
  jwks?: JWTVerifyGetKey;
  /** Expected `aud` claim. Always enforced. */
  audience: string;
  /** Expected `iss` claim. Optional but recommended for multi-tenant IdPs. */
  issuer?: string;
  /** Claim carrying the caller's role (default "role"; e.g. Auth0/Okta
   *  deployments often use a namespaced custom claim). Non-string values are
   *  ignored — role stays undefined. */
  roleClaim?: string;
  /** Provenance stamped on context.auth.source (issue #33). Defaults to
   *  'oidc' — this file IS the generic OIDC core; the Supabase preset
   *  (supabase-auth.mts) overrides it to 'supabase'. */
  source?: Extract<AuthSource, "supabase" | "oidc">;
}

/**
 * Best-effort bearer extraction (no throw): returns undefined when the
 * header is absent or malformed. Shared with the daemon's post-auth hook,
 * which re-reads the caller's token for the bundle-source refresh WITHOUT
 * ever storing it on the request context.
 */
export function tryExtractBearerToken(headers: Record<string, string>): string | undefined {
  // Header lookup is case-insensitive per RFC 9110; normalize keys.
  const raw = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  if (!raw) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match?.[1];
}

/** Strict bearer extraction: throws AuthenticationError when the header is
 *  absent or malformed. Shared with the multi-issuer router, which must
 *  extract the bearer BEFORE it can decode the iss claim to route on. */
export function extractBearerToken(headers: Record<string, string>): string {
  const raw = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  if (!raw) throw new AuthenticationError("missing authorization header");
  const token = tryExtractBearerToken(headers);
  if (!token) throw new AuthenticationError("malformed authorization header (expected Bearer token)");
  return token;
}

export function buildJwksAuthMiddleware(options: JwksAuthOptions): AuthMiddleware {
  if (!options.jwks && !options.jwksUrl) {
    throw new Error("buildJwksAuthMiddleware requires jwksUrl (or an injected jwks resolver)");
  }
  // One resolver per middleware INSTANCE: jose caches fetched keys inside the
  // resolver, so composed multi-issuer setups get a per-issuer JWKS cache for
  // free — the Supabase resolver never serves OIDC keys and vice versa.
  const jwks = options.jwks ?? createRemoteJWKSet(new URL(options.jwksUrl as string));
  const roleClaim = options.roleClaim ?? "role";
  const source = options.source ?? "oidc";

  return {
    async authenticate(headers, context): Promise<RequestContext> {
      const token = extractBearerToken(headers);

      let payload;
      try {
        // jwtVerify checks signature (via JWKS), exp/nbf, audience and
        // — when configured — issuer. The explicit algorithm allowlist is
        // belt-and-braces on red-zone auth: jose already confines algorithms
        // by key type, but a JWKS entry published without an `alg` field
        // stays bounded to the asymmetric families our issuers actually use
        // (Supabase signing keys and mainstream OIDC IdPs: ES256/RS256).
        ({ payload } = await jwtVerify(token, jwks, {
          audience: options.audience,
          issuer: options.issuer,
          algorithms: ["ES256", "RS256"],
        }));
      } catch (err) {
        // Fail closed: any verification error (bad signature, expired,
        // wrong audience/issuer, unknown kid, JWKS fetch failure, ...) → 401.
        throw new AuthenticationError(
          `token verification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new AuthenticationError("token has no subject (sub) claim");
      }

      const role = typeof payload[roleClaim] === "string" ? (payload[roleClaim] as string) : undefined;
      // ⚠ AUTH REVIEW — thread the raw, verified bearer onto the context so
      // downstream tools can act AS the caller under RLS (agent.reply's
      // per-request Supabase client, ADR-0026 Decision 4 path 1). This is the
      // ONLY place the token is retained past verification, and ONLY on the JWT
      // path: the token has just passed full jwtVerify (signature + exp + aud +
      // issuer), so it is a genuine, live user JWT — exactly the RLS credential
      // the bundle-source refresh already uses. It is never logged and never
      // outlives this request's context (see request-context.mts). The lab_
      // API-key middleware (api-key-auth.mts) deliberately does NOT set it: a
      // lab_ key is opaque, mints no auth.uid(), and cannot pass RLS.
      // `source` records WHICH issuer family verified the token — RLS
      // pass-through consumers (agent.reply) accept 'supabase' only.
      return { ...context, auth: { userId: payload.sub, role, token, source } };
    },
  };
}
