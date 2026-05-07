// Zod schema for the estimateEvolution MCP tool input.
// Source of truth for the JSON Schema exposed to MCP clients AND for runtime
// validation of incoming tool/call arguments.

import { z } from 'zod';
import { PhaseDistributionSchema } from './inputs.schema.mjs';

export const EstimateEvolutionInputSchema = z.object({
  name: z.string().min(1).describe(
    'Component name (e.g. "ERP", "LLM", "Electricity", "Air")'
  ),
  description: z.string().optional().describe(
    'Component label / semantic hint enrichable by upstream tooling. ' +
    'Distinct from `context`: never a fallback for it.'
  ),
  context: z.string().optional().describe(
    'Business environment in which the component exists — user-provided. ' +
    'Distinct from `description`: never a fallback for it.'
  ),
  certitude: z.number().min(0).max(1).optional().describe(
    'How well-understood and defined the component is (0 = novel/uncertain, 1 = fully understood). Required by s-curve strategy.'
  ),
  ubiquity: z.number().min(0).max(1).optional().describe(
    'How widespread the component is (0 = rare, 1 = ubiquitous). Required by s-curve strategy.'
  ),
  phaseDistribution: PhaseDistributionSchema.optional().describe(
    'Probability distribution over the Wardley evolution axis. ' +
    'Format: { bins: [{ position: 0..1, probability: 0..1 }] } summing to ~1. ' +
    'Consumed by the publication-analysis strategy when provided — replaces the ' +
    'legacy flat wonder/build/operate/usage fields.'
  ),
  space: z.enum(['economic', 'social_good', 'common_good']).optional().describe(
    'Pre-classification of the component\'s economic space. ' +
    'If provided, bypasses the classification gate. ' +
    'If omitted, the gate auto-detects from name + context.'
  ),
  strategy: z.string().default('auto').describe(
    'Strategy to use for evaluation. ' +
    '"auto" (default) routes the component to one strategy per detected type (anchor / solution / capability) ' +
    'via tool.config.json. ' +
    '"report" fans out to several strategies per type for a multi-perspective view. ' +
    'A specific method id (e.g. "write:capacity:s-curve") bypasses routing and runs that strategy directly. ' +
    'Available strategies are auto-discovered from the strategies directory.'
  ),
  mode: z.enum(['oneshot', 'conversational', 'default']).default('default').describe(
    'Execution mode. "oneshot" accepts all parameters in a single call. ' +
    '"conversational" enables multi-turn interaction that progressively asks clarifying questions. ' +
    '"default" auto-detects: uses one-shot when space or evaluation params are provided, conversational otherwise.'
  ),
  sessionState: z.string().optional().describe(
    'Serialized session state from a previous conversational exchange. ' +
    'Only used when mode is "conversational". Pass the sessionState from the previous response to continue the conversation.'
  ),
  forceEstimate: z.boolean().default(false).describe(
    'When true, forces estimation with whatever data has been gathered so far. ' +
    'Only used in "conversational" mode when you want to skip remaining questions.'
  ),
  pipeline: z.boolean().default(false).describe(
    'When true, enables enriched pipeline mode that orchestrates 3 evaluations: ' +
    '(1) capability pivot — the abstract capability is evaluated first, ' +
    '(2) state-of-the-art solution — a modern/SotA implementation of that capability (should be align with anchor), ' +
    '(3) legacy solution — your solution or an older/legacy implementation. ' +
    'Produces a complete OWM (onlinewardleymaps.com) output with pipeline syntax ' +
    'containing component, pipeline, and label declarations. ' +
    'When omitted or false, the default single-evaluation behavior is preserved.'
  ),
}).strict();

export type EstimateEvolutionInput = z.infer<typeof EstimateEvolutionInputSchema>;
