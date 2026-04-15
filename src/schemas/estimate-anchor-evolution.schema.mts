import { z } from 'zod';

export const EstimateAnchorEvolutionInputSchema = z.object({
  name: z.string().min(1).describe(
    'Anchor name — the user need (e.g. "Hot Beverage", "Urban Mobility", "Project Management")'
  ),
  context: z.string().min(1).describe(
    'Business/market context (required — anchor evaluation is highly context-dependent)'
  ),
  phase: z.number().int().min(1).max(4).optional().describe(
    'Pre-assessed evolution phase combining user and industry perception. ' +
    '1=Genesis (novel/unknown), 2=Custom (emerging/ROI), 3=Product (common/implementation advantage), 4=Commodity (standard/cost of entry). ' +
    'If omitted, LLM assesses it.'
  ),
}).strict();

export type EstimateAnchorEvolutionInput = z.infer<typeof EstimateAnchorEvolutionInputSchema>;
