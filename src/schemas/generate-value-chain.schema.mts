// Zod schema for the generateValueChain MCP tool input.
// Source of truth for the JSON Schema exposed to MCP clients AND for runtime
// validation of incoming tool/call arguments.

import { z } from 'zod';

export const OwmStyleSchema = z.enum(['plain', 'wardley', 'handwritten', 'colour', 'dark']);
export type OwmStyleInput = z.infer<typeof OwmStyleSchema>;

export const OwmSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();
export type OwmSizeInput = z.infer<typeof OwmSizeSchema>;

export const GenerateValueChainInputSchema = z.object({
  nlCommand: z.string().min(1).describe(
    'Natural-language command naming the subject organization or business archetype. ' +
    'Example: "construis-moi la chaîne de valeur d\'un fournisseur de solution de paiement en ligne". ' +
    'The first LLM call extracts title, angle, scope, objective, imperatives and temporality from this text. ' +
    'The map output (title and component names) follows the language of the command.',
  ),
  style: OwmStyleSchema.optional().describe(
    'OWM rendering style. One of: plain | wardley | handwritten | colour | dark. ' +
    'Defaults to "plain" when omitted.',
  ),
  size: OwmSizeSchema.optional().describe(
    'Canvas dimensions in pixels. Optional — when omitted, OWM uses its default size.',
  ),
}).strict();

export type GenerateValueChainInput = z.infer<typeof GenerateValueChainInputSchema>;
