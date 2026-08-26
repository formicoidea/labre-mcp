// Auth middleware. V1 is a no-op pass-through (ARCH-14): the daemon runs
// locally on loopback and trusts every caller. V3 SaaS replaces this with
// real OAuth/API-key authentication without changing handler signatures.

import type { RequestContext } from "#core/context/request-context.mjs";
import type { AuthenticatedContext } from "./auth-context.mjs";

/** Takes the business context the wire extracted and returns it enriched with
 *  the AUTH nature (CH-23): `userId` on the business side, the credential
 *  details on the delivery side. The dispatch strips the latter before any
 *  handler runs — see auth-context.mts. */
export interface AuthMiddleware {
  authenticate(
    headers: Record<string, string>,
    context: RequestContext,
  ): Promise<AuthenticatedContext>;
}

/** Thrown by any AuthMiddleware when a request cannot be authenticated.
 *  The `reason` is internal diagnostics only — the HTTP layer maps it to a
 *  plain 401 and must never leak it to the caller. Lives here (not in a
 *  concrete middleware) so the transport depends only on the interface. */
export class AuthenticationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AuthenticationError";
  }
}

export const noopAuthMiddleware: AuthMiddleware = {
  async authenticate(_headers, context) {
    return context;
  },
};
