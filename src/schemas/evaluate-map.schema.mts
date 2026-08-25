// Zod schema for the `evaluateMap` MCP tool input.
//
// Source of truth for the JSON Schema advertised to MCP clients AND for the
// runtime validation of incoming `tools/call` arguments.
//
// The shape is dictated by the FIRST step of `recipes/wardley/map/evaluate-map.recipe.json`
// (`render:wardley-map:owm:parse:dsl`, which consumes `{ dsl }` and nothing
// else). Everything downstream — the per-component fan-out over
// `$.chain.result.map.components` — is derived from that parse, so the tool
// takes exactly one field.

import { z } from 'zod';

export const EvaluateMapInputSchema = z
  .object({
    dsl: z
      .string()
      .min(1)
      .describe(
        'OWM (onlinewardleymaps.com) DSL source of the map to evaluate. ' +
          'Parsed into the canonical WardleyMap by `render:wardley-map:owm:parse:dsl`, ' +
          'then every parsed component is positioned in evolution and identified. ' +
          'Pass the file CONTENT, not a path — the daemon never reads the caller filesystem. ' +
          '`// key: value` header comments are preserved and projected onto the study context.',
      ),
  })
  .strict();

export type EvaluateMapInput = z.infer<typeof EvaluateMapInputSchema>;
