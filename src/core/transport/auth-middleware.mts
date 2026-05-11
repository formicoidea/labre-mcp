// Auth middleware. V1 is a no-op pass-through (ARCH-14): the daemon runs
// locally on loopback and trusts every caller. V3 SaaS replaces this with
// real OAuth/API-key authentication without changing handler signatures.

import type { RequestContext } from "../context/request-context.mjs";

export interface AuthMiddleware {
  authenticate(headers: Record<string, string>, context: RequestContext): Promise<RequestContext>;
}

export const noopAuthMiddleware: AuthMiddleware = {
  async authenticate(_headers, context) {
    return context;
  },
};
