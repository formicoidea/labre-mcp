// RequestContext — the BUSINESS nature of a call, and the only nature the
// kernel ever sees. It replaces process.cwd() and implicit env reads at
// runtime (ARCH-15).
//
// SPLIT AT CH-23 (ARCH-27). This type used to carry three natures at once:
// business (where the work happens), transport (which wire, which client) and
// auth (who, with what credential — including a raw bearer token). A strategy
// asking for its project root therefore received, in the same object, a live
// user JWT it had no business holding, and the kernel's own type could not be
// constructed without knowing what an issuer is.
//
// The auth nature now lives at the delivery seam, in
// `src/transport/auth-context.mts` (`AuthContext`, `AuthenticatedContext`), and
// `dispatch` strips it before a handler runs. What survives here is the ONE
// identity field the business path genuinely needs — `userId`, for quota
// attribution, RLS-scoped reads and telemetry bucketing. It is a plain opaque
// id: no token, no role, no issuer, nothing a caller could act with.
//
// The transport nature was never a field: it is an argument of the dispatch
// (`DispatchOptions.transport`) and stays there.

import { z } from "zod";

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
  /**
   * MINIMAL IDENTITY — the authenticated caller's opaque user id, and nothing
   * else about them. Stamped by the delivery seam from the AuthContext the auth
   * middleware produced (never by the caller: `extractContext` drops a
   * client-supplied `userId`, so identity can only come from a verified
   * credential or from nowhere at all).
   *
   * Its readers are exactly the ones that must attribute a run to a person:
   * the quota gate and the cost ledger at the delivery seam, the PostHog
   * distinct id, and any future RLS-scoped read. Absent on stdio, on local
   * dev and in-process lib-mode calls — every reader treats that as
   * "anonymous", never as an error.
   */
  userId: z.string().min(1).optional(),
});

export type RequestContext = z.infer<typeof RequestContextSchema>;
