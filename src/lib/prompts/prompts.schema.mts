// Zod schema for prompts.config.json — the per-strategy prompt registry.
//
// Structure:
//   { <strategyId>: { <promptName>: PromptEntry } }
//
// Each entry declares either a static template (with {{var}} substitution) or
// a code-resident function builder, plus the parser kind used on the LLM
// response. Templates live in external .md files referenced by `templateFile`
// so long prompts stay diff-friendly.

import { z } from 'zod';

export const ParserConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keyValue'), schemaId: z.string() }),
  z.object({ kind: z.literal('delimited'), startMarker: z.string(), endMarker: z.string() }),
  z.object({ kind: z.literal('custom'), id: z.string() }),
]);

export const PromptEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('template'),
    templateFile: z.string(),
    variables: z.array(z.string()),
    parser: ParserConfigSchema,
  }),
  z.object({
    kind: z.literal('function'),
    builderId: z.string(),
    parser: ParserConfigSchema,
  }),
]);

export const PromptsConfigSchema = z.record(
  z.string(),
  z.record(z.string(), PromptEntrySchema),
);

export type ParserConfig = z.infer<typeof ParserConfigSchema>;
export type PromptEntry = z.infer<typeof PromptEntrySchema>;
export type PromptsConfig = z.infer<typeof PromptsConfigSchema>;
