// Zod schema for the `generateValueChain` MCP tool input.
//
// Source of truth for the JSON Schema advertised to MCP clients AND for the
// runtime validation of incoming `tools/call` arguments.
//
// The FIRST step of `recipes/wardley/map/generate.recipe.json`
// (`wardley:map:value-chain:generate:top-down`) consumes a CANONICAL
// WardleyMap basemap and recovers the natural-language command from its
// `title` (+ optional `context`). Handing a raw WardleyMap to an agent asking
// for "generate me a map" is a poor surface, so the tool takes the
// natural-language pair instead and the handler projects it onto the basemap
// skeleton with the deterministic `wardley:map:basemap:generate:default`
// strategy before seeding `$.input`.

import { z } from 'zod';

export const GenerateValueChainInputSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .describe(
        'Natural-language command describing the map to generate ' +
          '(e.g. "Map the value chain of an online tea shop"). ' +
          'Becomes the basemap `title` the top-down generator reads.',
      ),
    context: z
      .string()
      .optional()
      .describe(
        'Business environment in which the value chain exists — user-provided. ' +
          'Appended to the prompt when the metadata extraction runs. ' +
          'Distinct from a component `description`: never a fallback for it.',
      ),
  })
  .strict();

export type GenerateValueChainInput = z.infer<typeof GenerateValueChainInputSchema>;
