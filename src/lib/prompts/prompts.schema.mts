// Zod schema for prompts.config.json — the per-strategy prompt registry.
//
// Structure:
//   { <strategyId>: { <promptName>: PromptEntry } }
//
// Each entry declares either a static template (with {{var}} substitution) or
// a code-resident function builder, plus the parser kind used on the LLM
// response. Templates live in external .md files referenced by `templateFile`
// so long prompts stay diff-friendly.
//
// `templateFile` accepts two shapes:
//   - Legacy string form: single .md file rendered as the user message.
//     Kept for backwards compatibility while the corpus is migrated.
//   - Split form `{ system, user }`: two files where the system file is
//     constant (no {{var}} placeholders allowed) and the user file contains
//     all variables. This separation is mandatory to exploit the SDK-level
//     systemPrompt channel and any prompt-caching that depends on stable
//     system content.

import { z } from 'zod';

export const ParserConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keyValue'), schemaId: z.string() }),
  z.object({ kind: z.literal('delimited'), startMarker: z.string(), endMarker: z.string() }),
  z.object({ kind: z.literal('custom'), id: z.string() }),
]);

export const TemplateFileSchema = z.union([
  z.string(),
  z.object({
    system: z.string(),
    user: z.string(),
  }),
]);

export const PromptEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('template'),
    templateFile: TemplateFileSchema,
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
export type TemplateFile = z.infer<typeof TemplateFileSchema>;
export type PromptEntry = z.infer<typeof PromptEntrySchema>;
export type PromptsConfig = z.infer<typeof PromptsConfigSchema>;

/** Runtime guard: is templateFile the split {system, user} shape? */
export function isSplitTemplateFile(
  tf: TemplateFile,
): tf is { system: string; user: string } {
  return typeof tf === 'object' && tf !== null && 'system' in tf && 'user' in tf;
}
