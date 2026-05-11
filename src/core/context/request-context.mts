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
});

export type RequestContext = z.infer<typeof RequestContextSchema>;
