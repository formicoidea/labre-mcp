// Auth middleware. V1 is a no-op pass-through (ARCH-14): the daemon runs
// locally on loopback and trusts every caller. V3 SaaS replaces this with
// real OAuth/API-key authentication without changing handler signatures.

import type { RequestContext } from "../context/request-context.mjs";

export interface AuthMiddleware {
  authenticate(headers: Record<string, string>, context: RequestContext): Promise<RequestContext>;
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
