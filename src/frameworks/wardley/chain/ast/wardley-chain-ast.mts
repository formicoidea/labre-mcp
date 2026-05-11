// WardleyChainAST: the in-memory typed JSON model of a Wardley chain map for
// labre-mcp. Built on top of the snapshot from WardleyAPI/render (ARCH-05),
// extended with labre-mcp annotations: an EvolutionAnnotation per component
// linking to a richer WardleyEvolutionAST analysis (the γ form, ARCH-22).
//
// The snapshot defines the data model (Component, Relation, Position, ...).
// This module wraps it with:
//   1. schemaVersion (BaseAST contract)
//   2. EvolutionAnnotation — light-weight evolution data carried on the map
//   3. labre-mcp metadata (title, context, sourceDsl, generatedAt)

import { z } from "zod";
import {
  ComponentSchema,
  RelationSchema,
  AcceleratorSchema,
  StepSchema,
} from "./schema-snapshot.mjs";
import type { BaseAST } from "../../../../core/ast/base-ast.mjs";
import { methodIdSchema } from "../../../../core/ast/base-strategy.mjs";
import { AnalysisRefSchema } from "../../../../core/ast/analysis-ref.mjs";

// ── Evolution annotation carried per component (γ form, ARCH-22) ─

export const EvolutionAnnotationSchema = z.object({
  value: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  method: methodIdSchema, // 5-segment methodId of the producing strategy
  // Pointer to a richer WardleyEvolutionAST artefact (ARCH-24). Null when no
  // detailed analysis was produced; omitted when the annotation is local.
  analysisRef: AnalysisRefSchema.optional(),
});
export type EvolutionAnnotation = z.infer<typeof EvolutionAnnotationSchema>;

// Component augmented with an optional evolution annotation. Otherwise
// identical to the snapshotted Component shape.
export const AnnotatedComponentSchema = ComponentSchema.extend({
  evolutionAnnotation: EvolutionAnnotationSchema.optional(),
});
export type AnnotatedComponent = z.infer<typeof AnnotatedComponentSchema>;

// ── WardleyChainAST — root node of the chain tool's AST ──────────

export const WardleyChainASTSchema = z.object({
  schemaVersion: z.literal("1.0"),
  title: z.string(),
  context: z.string().optional(),
  sourceDsl: z.string().optional(), // original OWM DSL if parsed from one
  generatedAt: z.string().optional(), // ISO 8601 — when this AST was built
  components: z.array(AnnotatedComponentSchema),
  relations: z.array(RelationSchema),
  accelerators: z.array(AcceleratorSchema).optional(),
  steps: z.array(StepSchema).optional(),
});

export type WardleyChainAST = z.infer<typeof WardleyChainASTSchema> & BaseAST;

export const CHAIN_AST_SCHEMA_VERSION = "1.0" as const;
