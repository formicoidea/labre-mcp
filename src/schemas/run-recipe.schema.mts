// Zod schema for the `runRecipe` MCP tool input envelope.
//
// A recipe is addressed by a 3-segment reference `<domain>:<tool>:<name>`
// (e.g. "wardley:map:draw-value-chain") which maps to the shipped/override
// path recipes/<domain>/<tool>/<name>.recipe.json (ARCH-08). The `input`
// seeds the recipe's `$.input` and its shape is recipe-specific.

import { z } from 'zod';

export const RunRecipeCallSchema = z
  .object({
    recipe: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*){2}$/,
        'recipe ref must be "<domain>:<tool>:<name>" (e.g. wardley:map:draw-value-chain)',
      )
      .describe('Recipe reference, 3 segments domain:tool:name. See docs/architecture/recipes.md.'),
    input: z
      .unknown()
      .describe('Input seeded at the recipe’s $.input. Shape depends on the recipe.'),
  })
  .strict();

export type RunRecipeCall = z.infer<typeof RunRecipeCallSchema>;
