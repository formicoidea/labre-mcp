// WardleyEvolutionAST — the γ form (ARCH-22).
//
// The chain map carries a lightweight EvolutionAnnotation per component
// (see frameworks/wardley/chain/ast/wardley-chain-ast.mts). The richer
// analysis — signals, LLM reasoning trace, insights, and the canonical
// result — lives here, in evolution AST, and is referenced from chain
// via `analysisRef`.
//
// One WardleyEvolutionAST = one evolution analysis (typically for one
// component or one capability at one moment in time). Multiple strategies
// may contribute reasoning and insights; their numerical agreement is
// captured in `result.consensus`.

import { z } from "zod";
import type { BaseAST } from "../../../../core/ast/base-ast.mjs";
import { methodIdSchema } from "../../../../core/ast/base-strategy.mjs";

// ── Subject (what the analysis is about) ─────────────────────────

export const EvolutionSubjectSchema = z.object({
  name: z.string().min(1),
  capability: z.string().optional(),
  description: z.string().optional(),
  context: z.string().optional(),
  date: z.string().optional(), // ISO 8601 or year string (reference temporal anchor)
  componentRef: z
    .object({
      mapId: z.string(),
      componentId: z.string(),
    })
    .optional(),
});
export type EvolutionSubject = z.infer<typeof EvolutionSubjectSchema>;

// ── Signals (inputs that fed the analysis) ───────────────────────

export const EvolutionSignalSchema = z.object({
  name: z.string().min(1), // e.g. "certitude", "ubiquity", "publication_count_2020"
  // any: signal value is type-open by design — strategies declare semantics
  value: z.unknown(),
  source: z.enum([
    "user-input",
    "web-search",
    "cpc-database",
    "llm-internal",
    "computed",
    "naming-convention",
  ]),
  capturedAt: z.string(), // ISO 8601
});
export type EvolutionSignal = z.infer<typeof EvolutionSignalSchema>;

// ── Reasoning (LLM trace, no longer thrown away — ARCH-22) ───────

export const EvolutionReasoningSchema = z.object({
  by: methodIdSchema, // 5-segment methodId of the producing strategy
  text: z.string(), // the raw LLM reasoning, captured verbatim
  promptTokens: z.number().int().min(0).optional(),
  completionTokens: z.number().int().min(0).optional(),
});
export type EvolutionReasoning = z.infer<typeof EvolutionReasoningSchema>;

// ── Insights (higher-level interpretation) ───────────────────────

export const EvolutionInsightSchema = z.object({
  text: z.string().min(1),
  by: methodIdSchema, // 5-segment methodId
  type: z.enum([
    "historical-context",
    "comparable",
    "trajectory",
    "cluster",
    "phase-distribution-anomaly",
    "other",
  ]),
  confidence: z.number().min(0).max(1).optional(),
});
export type EvolutionInsight = z.infer<typeof EvolutionInsightSchema>;

// ── Result (the canonical numerical output) ──────────────────────

export const EvolutionConsensusSchema = z.object({
  contributingStrategies: z.array(methodIdSchema).min(1),
  // Bounded [0,1]: 1 = perfect agreement, 0 = maximal disagreement
  agreement: z.number().min(0).max(1),
  divergence: z
    .array(
      z.object({
        strategy: methodIdSchema,
        value: z.number(),
      }),
    )
    .optional(),
});
export type EvolutionConsensus = z.infer<typeof EvolutionConsensusSchema>;

export const EvolutionResultSchema = z.object({
  evolution: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  method: methodIdSchema, // 5-segment methodId of the canonical-result producer
  consensus: EvolutionConsensusSchema.optional(),
});
export type EvolutionResultData = z.infer<typeof EvolutionResultSchema>;

// ── WardleyEvolutionAST root ─────────────────────────────────────

export const WardleyEvolutionASTSchema = z.object({
  schemaVersion: z.literal("1.0"),
  subject: EvolutionSubjectSchema,
  generatedAt: z.string(), // ISO 8601 — when this analysis was built
  signals: z.array(EvolutionSignalSchema).default([]),
  reasoning: z.array(EvolutionReasoningSchema).default([]),
  insights: z.array(EvolutionInsightSchema).default([]),
  result: EvolutionResultSchema,
});

export type WardleyEvolutionAST = z.infer<typeof WardleyEvolutionASTSchema> & BaseAST;

export const EVOLUTION_AST_SCHEMA_VERSION = "1.0" as const;
