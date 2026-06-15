// Canonical `JSON-labre` artifact root (ast-schema.md v0.1.0 § 2.0).
//
// The artifact that circulates between commands: one business sub-tree per
// domain tool (each validated by its own schema) plus the cross-cutting
// `envelope` (conversational + traceability, ARCH-22). Each `wardley.<tool>`
// sub-tree is optional — present only if the command that fills it ran. The
// envelope structure is mandatory so listeners and downstream tools can rely
// on it.

import { z } from 'zod';
import { WardleyMapSchema } from './wardley-map.schema.mjs';
import { JsonLabreEnvelopeSchema } from './command.schema.mjs';

export const JsonLabreWardleySchema = z
  .object({
    map: WardleyMapSchema.optional(),
    // The remaining tool sub-trees are validated by their own schemas as they
    // land (doctrine, climate, gameplay, iteration). Kept open until then.
    doctrine: z.unknown().optional(),
    climate: z.unknown().optional(),
    gameplay: z.unknown().optional(),
    iteration: z.unknown().optional(),
  })
  .strict();

export const JsonLabreSchema = z
  .object({
    version: z.string().default('0.1.0'),
    wardley: JsonLabreWardleySchema.default({}),
    envelope: JsonLabreEnvelopeSchema,
  })
  .strict();

export type JsonLabreWardley = z.infer<typeof JsonLabreWardleySchema>;
export type JsonLabre = z.infer<typeof JsonLabreSchema>;
