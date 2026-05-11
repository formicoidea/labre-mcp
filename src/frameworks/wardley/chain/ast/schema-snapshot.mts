// Snapshot of the data-layer types from WardleyAPI/packages/render/src/schema.ts.
// This is a copy (ARCH-05): divergence is assumed and acceptable.
// Render-specific types (RenderConfig, theme, coordinate space) are intentionally
// omitted — labre-mcp's chain AST is the data model, not the rendering model.
// If render-specific types become needed, snapshot them on demand.

import { z } from "zod";

// any: round helper — runtime numeric utility, not a type
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

// ── Evolution axis ───────────────────────────────────────────────

export const EvolutionSchema = z.number().min(0).max(1).transform(round3);
export type Evolution = z.infer<typeof EvolutionSchema>;

export const EvolutionRangeSchema = z
  .tuple([EvolutionSchema, EvolutionSchema])
  .refine(([min, max]) => min <= max, {
    message: "EvolutionRange: min must be <= max",
  });
export type EvolutionRange = z.infer<typeof EvolutionRangeSchema>;

// ── Position (evolution + visibility, both [0,1]) ────────────────

export const EvolutionFieldSchema = z.object({
  scalar: EvolutionSchema,
  range: EvolutionRangeSchema.optional(),
});
export type EvolutionField = z.infer<typeof EvolutionFieldSchema>;

export const VisibilityFieldSchema = z.object({
  scalar: z.number().min(0).max(1).transform(round3),
});
export type VisibilityField = z.infer<typeof VisibilityFieldSchema>;

export const PositionSchema = z.object({
  evolution: EvolutionFieldSchema,
  visibility: VisibilityFieldSchema,
});
export type Position = z.infer<typeof PositionSchema>;

// ── Component types ──────────────────────────────────────────────

export const ComponentTypeEnum = z.enum([
  "component",
  "user-need",
  "pipeline",
  "note",
  "anchor",
  "market",
  "ecosystem",
]);
export type ComponentType = z.infer<typeof ComponentTypeEnum>;

export const NatureEnum = z.enum([
  "activity",
  "practice",
  "data",
  "knowledge",
  "natural_need",
  "technical_system_need",
]);
export type Nature = z.infer<typeof NatureEnum>;

// ── Label with optional offset ───────────────────────────────────

export const LabelPositionSchema = z.object({
  dx: z.number(),
  dy: z.number(),
});
export type LabelPosition = z.infer<typeof LabelPositionSchema>;

export const LabelSchema = z.object({
  name: z.string(),
  position: LabelPositionSchema.optional(),
});
export type Label = z.infer<typeof LabelSchema>;

// ── Method annotation (Build/Buy/Outsource) ──────────────────────

export const MethodSchema = z.object({
  type: z.string(),
  preconisation: z.string(),
});
export type Method = z.infer<typeof MethodSchema>;

// ── Evolves arrow ────────────────────────────────────────────────

export const EvolveTypeEnum = z.enum([
  "natural",
  "ecosystem",
  "forced",
  "late",
]);
export type EvolveType = z.infer<typeof EvolveTypeEnum>;

export const EvolvesToSchema = z.object({
  position: PositionSchema,
  evolveType: EvolveTypeEnum.default("natural"),
  inertia: z.boolean().optional(),
});
export type EvolvesTo = z.infer<typeof EvolvesToSchema>;

// ── Pipeline rectangle geometry ──────────────────────────────────

export const PipelineGeometrySchema = z.object({
  evoStart: EvolutionSchema,
  evoEnd: EvolutionSchema,
  visStart: z.number().min(0).max(1).transform(round3),
  visEnd: z.number().min(0).max(1).transform(round3),
  handleEvolution: EvolutionSchema.optional(),
});
export type PipelineGeometry = z.infer<typeof PipelineGeometrySchema>;

// ── Component (the atomic unit) ──────────────────────────────────

export const ComponentSchema = z.object({
  id: z.string(),
  label: LabelSchema,
  type: ComponentTypeEnum,
  nature: NatureEnum.optional(),
  position: PositionSchema,
  description: z.string().optional(),
  evolvesTo: z.array(EvolvesToSchema).optional(),
  pipelineGeometry: PipelineGeometrySchema.optional(),
  color: z.string().optional(),
  method: MethodSchema.optional(),
});
export type Component = z.infer<typeof ComponentSchema>;

// ── Relation (link between components) ───────────────────────────

export const RelationTypeEnum = z.enum(["DependsOn", "Flow", "Constraint"]);
export type RelationType = z.infer<typeof RelationTypeEnum>;

export const FlowSchema = z.object({
  label: z.string(),
  style: z.enum(["solid", "dashed", "bold"]).default("solid"),
});
export type Flow = z.infer<typeof FlowSchema>;

export const RelationSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: RelationTypeEnum.default("DependsOn"),
  flow: FlowSchema.optional(),
});
export type Relation = z.infer<typeof RelationSchema>;

// ── Accelerator (gameplay annotation) ────────────────────────────

export const AcceleratorTypeEnum = z.enum(["accelerator", "deaccelerator"]);
export type AcceleratorType = z.infer<typeof AcceleratorTypeEnum>;

export const AcceleratorSchema = z.object({
  id: z.string(),
  label: z.string(),
  position: PositionSchema,
  type: AcceleratorTypeEnum,
});
export type Accelerator = z.infer<typeof AcceleratorSchema>;

// ── Step (numbered annotation) ───────────────────────────────────

export const StepSchema = z.object({
  id: z.string(),
  number: z.number().int().min(1),
  position: PositionSchema,
  color: z.string().optional(),
});
export type Step = z.infer<typeof StepSchema>;

// ── Phase mapping (Genesis / Custom / Product / Commodity) ───────

export const PhaseMappingEntrySchema = z
  .object({
    start: z.number().min(0).max(1),
    end: z.number().min(0).max(1),
    styleKey: z.string().min(1),
  })
  .refine(({ start, end }) => start < end, {
    message: "PhaseMappingEntry: start must be < end",
  });
export type PhaseMappingEntry = z.infer<typeof PhaseMappingEntrySchema>;

export const PhaseMappingSchema = z.array(PhaseMappingEntrySchema);
export type PhaseMapping = z.infer<typeof PhaseMappingSchema>;

export const DEFAULT_PHASE_MAPPING: PhaseMapping = [
  { start: 0, end: 0.175, styleKey: "genesis" },
  { start: 0.175, end: 0.4, styleKey: "custom-built" },
  { start: 0.4, end: 0.7, styleKey: "product" },
  { start: 0.7, end: 1.0, styleKey: "commodity" },
];

// ── WardleyMap (root data type) ──────────────────────────────────

export const WardleyMapSchema = z.object({
  title: z.string(),
  components: z.array(ComponentSchema),
  relations: z.array(RelationSchema),
  context: z.string().optional(),
  accelerators: z.array(AcceleratorSchema).optional(),
  steps: z.array(StepSchema).optional(),
});
export type WardleyMap = z.infer<typeof WardleyMapSchema>;
