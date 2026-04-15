import { z } from 'zod';

export const GenerateValueChainInputSchema = z.object({
  description: z.string().min(1).describe(
    'Business description or user need to map'
  ),
  filename: z.string().optional().describe(
    'Output filename without extension (auto-generated if omitted)'
  ),
  outputDir: z.string().default('maps/myMaps').describe(
    'Output directory (default: maps/myMaps)'
  ),
  strategy: z.string().default('timeline-benchmark').describe(
    'Evolution evaluation strategy (default: timeline-benchmark)'
  ),
}).strict();

export type GenerateValueChainInput = z.infer<typeof GenerateValueChainInputSchema>;
