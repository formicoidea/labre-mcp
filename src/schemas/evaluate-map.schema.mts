import { z } from 'zod';

export const EvaluateMapInputSchema = z.object({
  filePath: z.string().min(1).describe(
    'Path to the .wm file to evaluate'
  ),
  strategy: z.string().default('all').describe(
    'Evaluation strategy (default: all)'
  ),
  updateFile: z.boolean().default(true).describe(
    'Whether to update the .wm file with new positions (default: true)'
  ),
}).strict();

export type EvaluateMapInput = z.infer<typeof EvaluateMapInputSchema>;
