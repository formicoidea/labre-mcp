import { z } from 'zod';

export const EvaluateMapInputSchema = z.object({
  filePath: z.string().min(1).describe(
    'Path to the .wm file to evaluate'
  ),
  strategy: z.string().default('auto').describe(
    'Evaluation strategy. "auto" (default) routes each component to one strategy ' +
    'per detected type via tool.config.json. "report" fans out to multiple ' +
    'strategies per type. A specific method id (e.g. "write:capacity:s-curve") ' +
    'forces that strategy on every economic component.'
  ),
  updateFile: z.boolean().default(true).describe(
    'Whether to update the .wm file with new positions (default: true)'
  ),
}).strict();

export type EvaluateMapInput = z.infer<typeof EvaluateMapInputSchema>;
