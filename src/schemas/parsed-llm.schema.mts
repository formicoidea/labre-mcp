// Zod schemas for LLM response parsers.
//
// Used with `.parse()` on trusted regex output to produce typed results,
// and as the source of truth for the return types of parser functions.

import { z } from 'zod';

/** Single property evaluation parsed from an LLM response line like `Market=3|reason`. */
export const ParsedPropertyEvaluationSchema = z.object({
  property: z.string(),
  phase: z.number().int().min(1).max(4),
  reason: z.string(),
});
export type ParsedPropertyEvaluation = z.infer<typeof ParsedPropertyEvaluationSchema>;

/** Output of parseAutoResponse — list of per-property evaluations. */
export const ParsedAutoResponseSchema = z.array(ParsedPropertyEvaluationSchema);
export type ParsedAutoResponse = z.infer<typeof ParsedAutoResponseSchema>;

/** Output of parseCapabilityResponse (identify-capability). */
export const ParsedCapabilityResponseSchema = z.object({
  type: z.string(),
  nature: z.string(),
  capability: z.string(),
  confidence: z.number(),
  justification: z.string(),
  context: z.string().optional(),
  name: z.string().optional(),
});
export type ParsedCapabilityResponse = z.infer<typeof ParsedCapabilityResponseSchema>;

/** Output of parseHistoryIterationResponse (timeline-benchmark). Throws when fields missing. */
export const ParsedHistoryIterationSchema = z.object({
  name: z.string(),
  date: z.number(),
});
export type ParsedHistoryIteration = z.infer<typeof ParsedHistoryIterationSchema>;
