// API-key auth for external harnesses (Claude Code, ...): bearers with the
// lab_ prefix are opaque personal keys created in the labre UI. They are
// validated against the labre_mcp.validate_api_key SECURITY DEFINER RPC
// (PostgREST, public anon key) — no JWT is minted anywhere and the daemon
// keeps holding no privileged credential. Fail-closed like jwks-auth: any
// validation problem throws AuthenticationError → generic 401.
//
// Successful validations are cached (default 60 s) so the DB round-trip is
// amortized across a session; revocation takes effect within one TTL.

import type { RequestContext } from "../context/request-context.mjs";
import type { AuthMiddleware } from "./auth-middleware.mjs";
import { AuthenticationError } from "./auth-middleware.mjs";
import { tryExtractBearerToken } from "./jwks-auth.mjs";

export const API_KEY_PREFIX = "lab_";

/** Resolves an API key to its owner, or undefined when the key is unknown,
 *  revoked or expired. Injectable for tests. */
export type ApiKeyValidator = (apiKey: string) => Promise<{ userId: string } | undefined>;

export interface ApiKeyAuthOptions {
  /** Supabase project URL, e.g. https://xyzcompany.supabase.co */
  supabaseUrl: string;
  /** Public anon key — same credential the bundle source already uses. */
  anonKey: string;
  /** Injectable for tests. Defaults to the validate_api_key RPC. */
  validate?: ApiKeyValidator;
  /** How long a successful validation is cached. Default 60_000 ms. */
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

function buildRpcValidator(supabaseUrl: string, anonKey: string): ApiKeyValidator {
  return async (apiKey: string) => {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/validate_api_key`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        // The RPC lives in the labre_mcp schema, not public.
        "Content-Profile": "labre_mcp",
      },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) {
      throw new Error(`validate_api_key RPC failed: HTTP ${response.status}`);
    }
    // unknown: PostgREST response is untrusted input — narrowed field by field.
    const rows = (await response.json()) as Array<{ user_id?: unknown }>;
    const userId = rows?.[0]?.user_id;
    return typeof userId === "string" ? { userId } : undefined;
  };
}

export function buildApiKeyAuthMiddleware(options: ApiKeyAuthOptions): AuthMiddleware {
  const validate = options.validate ?? buildRpcValidator(options.supabaseUrl, options.anonKey);
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  // Only successes are cached: a failed lookup stays a fresh DB question, so
  // a key created in the UI works immediately.
  const cache = new Map<string, { userId: string; until: number }>();

  return {
    async authenticate(headers, context): Promise<RequestContext> {
      const token = tryExtractBearerToken(headers);
      if (!token) throw new AuthenticationError("missing or malformed authorization header");
      if (!token.startsWith(API_KEY_PREFIX)) {
        throw new AuthenticationError("bearer is not an API key");
      }

      const cached = cache.get(token);
      if (cached && cached.until > Date.now()) {
        return { ...context, auth: { userId: cached.userId, source: "api-key" } };
      }
      cache.delete(token);

      let owner;
      try {
        owner = await validate(token);
      } catch (err) {
        // Fail closed: RPC/network failure → 401, never a pass-through.
        throw new AuthenticationError(
          `api key validation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!owner) throw new AuthenticationError("unknown, revoked or expired api key");

      cache.set(token, { userId: owner.userId, until: Date.now() + ttlMs });
      // Provenance (issue #33): a lab_ key resolves a userId but is NOT a JWT
      // — no token is threaded (it cannot pass RLS) and the source says so.
      return { ...context, auth: { userId: owner.userId, source: "api-key" } };
    },
  };
}

/** Routes each request on the bearer's shape: lab_-prefixed keys go to the
 *  API-key middleware, everything else (JWTs, garbage) to the JWT one — whose
 *  own verification rejects the garbage. Requests without a bearer go to the
 *  JWT middleware for its canonical missing-header error. */
export function routeBearerAuth(jwt: AuthMiddleware, apiKey: AuthMiddleware): AuthMiddleware {
  return {
    async authenticate(headers, context): Promise<RequestContext> {
      const token = tryExtractBearerToken(headers);
      const middleware = token?.startsWith(API_KEY_PREFIX) ? apiKey : jwt;
      return middleware.authenticate(headers, context);
    },
  };
}
