// Zod schemas for the value-chain pipeline. Used by the LLM #2 parser to
// validate generated RawValueChain shape before it enters the deterministic
// positioning stages.

import { z } from 'zod';
import { CapabilityNatureSchema } from './inputs.schema.mjs';

export const TemporalitySchema = z.enum(['past', 'present', 'future']);

export const ChainMetadataSchema = z.object({
  title: z.string().min(1),
  angle: z.string().min(1),
  scope: z.string().min(1),
  objective: z.string().default(''),
  imperatives: z.array(z.string()).default([]),
  temporality: TemporalitySchema.default('present'),
  contextSummary: z.string().default(''),
}).strict();

export const WardleyPhaseKeySchema = z.enum(['phase1', 'phase2', 'phase3', 'phase4']);

// Mirrors IdentifyCapabilityInputSchema.type enum — kept in sync manually for
// now to avoid a circular import between two sibling schema files.
export const OwmComponentTypeSchema = z.enum([
  'anchor',
  'component',
  'pipeline',
  'market',
  'ecosystem',
]);

export const ChainRoleSchema = z.enum(['anchor', 'need', 'capability']);

export const ValueChainComponentSchema = z.object({
  name: z.string().min(1),
  type: OwmComponentTypeSchema,
  nature: CapabilityNatureSchema.optional(),
  description: z.string().optional(),
  context: z.string().optional(),
  role: ChainRoleSchema,
  // Rough X for visual clarity, set by generate-chain (LLM #2) inline with
  // the rest of the component fields. NOT evolution maturity. Deterministic
  // adjust-x keeps the final X within ±0.10 of this hint.
  xHint: z.number().min(0).max(1).optional(),
}).strict();

export const DependencyLinkSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
}).strict();

// Lenient raw schema: metadata is optional in the LLM response (the caller
// already has it from LLM #1). The parser fills it in from the context.
export const RawValueChainSchema = z.object({
  metadata: ChainMetadataSchema.optional(),
  components: z.array(ValueChainComponentSchema).min(1),
  links: z.array(DependencyLinkSchema).default([]),
}).strict();

export type RawValueChainParsed = z.infer<typeof RawValueChainSchema>;
