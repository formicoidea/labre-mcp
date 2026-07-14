// RequestContext travels with every tool call. It replaces process.cwd() and
// implicit env reads at runtime (ARCH-15). The daemon extracts it from the
// JSON-RPC request body; in-process callers (tests, internal handlers)
// construct it explicitly.

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
  // Populated by the auth middleware (e.g. Supabase JWT) on the HTTP
  // transport; absent on stdio and unauthenticated local dev.
  auth: z
    .object({
      userId: z.string().min(1),
      role: z.string().optional(),
    })
    .optional(),
});

export type RequestContext = z.infer<typeof RequestContextSchema>;
