import { z } from 'zod';

export const IdentifyCapabilityInputSchema = z.object({
  name: z.string().min(1).describe(
    'Component name or label (e.g. "CRM", "Kubernetes", "Data Warehouse")'
  ),
  type: z.enum(['anchor', 'component', 'pipeline', 'market', 'ecosystem']).optional().describe(
    'Component type from the OWM DSL. If provided, takes priority over LLM estimation. ' +
    'Non-eligible types (anchor, market, ecosystem) are skipped immediately.'
  ),
  description: z.string().optional().describe(
    'Free-text description or business context for the component'
  ),
  context: z.string().optional().describe(
    'Additional context about how the component is used in the value chain'
  ),
}).strict();

export type IdentifyCapabilityInput = z.infer<typeof IdentifyCapabilityInputSchema>;
