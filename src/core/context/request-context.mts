// RequestContext travels with every tool call. It replaces process.cwd() and
// implicit env reads at runtime (ARCH-15). The daemon extracts it from the
// JSON-RPC request body; in-process callers (tests, internal handlers)
// construct it explicitly.

import { z } from "zod";

/** Which auth middleware authenticated the caller. Provenance travels with
 *  the context so tools can gate on the ISSUER FAMILY, not just on the shape
 *  of the credentials — e.g. agent.reply requires a Supabase-issued JWT
 *  (auth.uid() under RLS), and a valid OIDC token at the door is worth
 *  nothing against PostgREST (see multi-issuer-auth.mts). */
export const AuthSourceSchema = z.enum(["supabase", "oidc", "api-key"]);
export type AuthSource = z.infer<typeof AuthSourceSchema>;

export const RequestContextSchema = z.object({
  projectId: z.string().min(1),
  projectRoot: z.string().min(1),
  sessionId: z.string().min(1),
  domain: z.string().min(1),
  artifactDir: z.string().min(1).optional(),
  // The human user's original, verbatim prompt — the request as the person
  // phrased it, NOT the calling agent's structured reformulation. Ambient and
  // user-supplied (the MCP never derives or enriches it), so any strategy can
  // judge an agent's extraction against the original intent. Optional: absent
  // on stdio and simple clients. Never forwarded to telemetry (metadata-only).
  userPrompt: z.string().optional(),
  // Populated by the auth middleware (e.g. Supabase JWT) on the HTTP
  // transport; absent on stdio and unauthenticated local dev.
  auth: z
    .object({
      userId: z.string().min(1),
      role: z.string().optional(),
      // ⚠ AUTH REVIEW — raw caller bearer, threaded ONLY by the JWT auth modes
      // (supabase/oidc via jwks-auth.mts). It is the RLS pass-through credential
      // for tools that must act AS the caller (agent.reply → conversation
      // reads/writes under RLS). Deliberately NEVER set for lab_ API keys
      // (api-key-auth.mts leaves it undefined — a lab_ key is not a JWT and
      // resolves no auth.uid(), so it cannot pass RLS). Handling discipline,
      // mirrors supabase-bundle-source's token invariants: it lives ONLY on the
      // per-request context, is never logged, and is discarded when the request
      // settles. Do not persist, forward, or serialise it.
      token: z.string().min(1).optional(),
      // Provenance: which middleware authenticated the caller. Set by every
      // HTTP auth middleware ('supabase' | 'oidc' | 'api-key'); absent only on
      // in-process/stdio contexts that never crossed an auth middleware.
      // Conversation tools (agent.reply) gate on it: ONLY 'supabase' can pass
      // RLS, so an 'oidc' caller is refused first-class at the tool entry
      // instead of failing invisibly downstream (issue #33).
      source: AuthSourceSchema.optional(),
    })
    .optional(),
});

export type RequestContext = z.infer<typeof RequestContextSchema>;
