// PipelineEvent is the canonical shape of any event emitted on the kernel bus.
// V1: emitted in-memory only. V2 may persist these (DuckDB) — schema is
// versioned to allow forward-compatible evolution.
// See ARCH-10 (bus design) and ARCH-22 (strategy result format).

import { z } from "zod";

export const PipelineEventSchema = z.object({
  schemaVersion: z.literal("1.0"),
  recipeRunId: z.string(),
  sessionId: z.string().optional(),
  stepId: z.string(),
  methodId: z.string(),
  phase: z.enum(["step-start", "step-end", "step-error", "listener-insight", "run-end"]),
  timestamp: z.string(), // ISO 8601
  durationMs: z.number().optional(),
  degraded: z.boolean().optional(),
  // any: per-event payload is open — strategies and listeners attach what they need
  payload: z.unknown().optional(),
});

export type PipelineEvent = z.infer<typeof PipelineEventSchema>;
