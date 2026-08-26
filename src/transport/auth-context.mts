// The AUTH nature of a call — who the caller is and with what credential.
// It lives HERE, at the delivery seam, and never reaches the kernel (CH-23 /
// ARCH-27, the third cut).
//
// Until CH-23 these fields were a sub-object of `RequestContext`, which meant
// every strategy, every listener and every artefact-writing path received a
// raw user JWT it had no use for. The split is the fix: an auth middleware
// produces an `AuthenticatedContext`, the transport carries it as far as the
// dispatch, and `toBusinessContext` drops the auth nature before any handler —
// let alone any strategy — sees the context. The kernel keeps `userId` alone
// (see request-context.mts), which is an id, not a capability.
//
// `token` and `source` are KEPT, deliberately (human arbitration 2026-08-26).
// They have no reader today — their consumer, agentReply, retired in slice B4
// (ADR-0028 amendment 2026-07-18) — but the auth tests that assert them pin
// real behaviour of the doors, and whether the daemon should STOP retaining a
// verified bearer is an auth decision (red zone, CODEOWNERS), not a side effect
// of a layering refactor. What CH-23 changes is their BLAST RADIUS: they now
// exist only on the transport side of the seam.

import { z } from "zod";
import type { RequestContext } from "#core/context/request-context.mjs";

/** Which auth middleware authenticated the caller. Provenance travels with
 *  the auth nature so a delivery-side gate can discriminate on the ISSUER
 *  FAMILY, not just on the shape of the credentials: a valid OIDC token at the
 *  door is worth nothing against PostgREST (see multi-issuer-auth.mts). */
export const AuthSourceSchema = z.enum(["supabase", "oidc", "api-key"]);
export type AuthSource = z.infer<typeof AuthSourceSchema>;

export const AuthContextSchema = z.object({
  userId: z.string().min(1),
  role: z.string().optional(),
  /**
   * ⚠ AUTH REVIEW — the raw caller bearer, threaded ONLY by the JWT auth doors
   * (supabase/oidc via jwks-auth.mts). It WAS the RLS pass-through credential
   * for tools acting AS the caller.
   *
   * ⚠ NO READER SINCE B4 (ADR-0028 amendment 2026-07-18). The remote-bundle
   * refresh is NOT one: it re-extracts the bearer from the request headers
   * itself (http-daemon.mts, onAuthenticated hook). So the daemon retains a
   * verified user JWT on every authenticated request and uses it for nothing.
   * Whether to STOP retaining it is a deliberate AUTH decision left open rather
   * than silently taken here.
   *
   * Deliberately NEVER set for lab_ API keys (api-key-auth.mts leaves it
   * undefined — a lab_ key is not a JWT and resolves no auth.uid(), so it
   * cannot pass RLS). Handling discipline: it lives ONLY on the per-request
   * AuthenticatedContext, is never logged, is stripped by `toBusinessContext`
   * before any handler runs, and is discarded when the request settles. Do not
   * persist, forward, or serialise it.
   */
  token: z.string().min(1).optional(),
  /** Provenance: which middleware authenticated the caller. Set by every HTTP
   *  auth middleware; absent only on in-process/stdio paths that never crossed
   *  one. The issue-#33 rationale (only 'supabase' can pass RLS) stays valid
   *  for whatever conversation tool comes back. */
  source: AuthSourceSchema.optional(),
});
export type AuthContext = z.infer<typeof AuthContextSchema>;

/**
 * What an auth middleware returns and what the transport carries: the business
 * context PLUS the auth nature. Structurally a `RequestContext`, so anything
 * expecting the business shape accepts it — but the dispatch calls
 * `toBusinessContext` first, so nothing downstream of the seam actually
 * receives the auth object.
 */
export interface AuthenticatedContext extends RequestContext {
  auth?: AuthContext;
}

/** Drop the auth nature. The one function that crosses the seam inward — call
 *  it once, at the dispatch, and never hand an `AuthenticatedContext` to a
 *  tool handler, a listener or a strategy. */
export function toBusinessContext(context: AuthenticatedContext): RequestContext {
  const { auth: _auth, ...business } = context;
  return business;
}

/** Stamp the verified identity onto both natures at once: `userId` on the
 *  business context (the kernel's minimal identity) and the full `AuthContext`
 *  on the delivery side. Every middleware ends with this call, so the two can
 *  never drift apart. */
export function withAuth(context: RequestContext, auth: AuthContext): AuthenticatedContext {
  return { ...context, userId: auth.userId, auth };
}
