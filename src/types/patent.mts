// Patent domain types — used by lib/patent/* and work-on-evolution/write/patent/*
//
// Source of truth lives in src/schemas/patent.schema.mts (Zod). This file
// re-exports the inferred types for convenience and keeps indicator/BigQuery
// config interfaces that have no runtime validation.

export type {
  CpcDistributionEntry,
  YearlyClassification,
  CitationData,
  ClaimsTimelineEntry,
  AssigneeData,
  GeoData,
  SectorData,
  ExpirationData,
  PatentData,
} from '../schemas/patent.schema.mjs';

// ─── Indicator config + results ─────────────────────────────────────────────

export interface IndicatorConfig {
  key: string;
  weight: number;
  enabled: boolean;
}

export interface IndicatorBreakdownEntry {
  key: string;
  score: number;
  weight: number;
  weightNormalized: number;
}

export interface WeightedAggregateResult {
  value: number;
  breakdown: IndicatorBreakdownEntry[];
  enabledCount: number;
}

export interface IndicatorScores {
  // Certitude axis
  convergenceHHI: number;
  stabiliteTaxonomique: number;
  densiteCitation: number;
  retrecissementClaims: number;
  // Ubiquité axis
  diversiteAssignees: number;
  couvertureGeo: number;
  diffusionSectorielle: number;
  ratioExpires: number;
}

export interface IndicatorResults {
  certitude: WeightedAggregateResult;
  ubiquite: WeightedAggregateResult;
  scores: IndicatorScores;
}

// ─── BigQuery / CPC taxonomy ────────────────────────────────────────────────

/** Raw row returned by BigQuery (loosely typed per query) */
export type BigQueryRow = Record<string, unknown>;

/** Entry returned by CPC taxonomy cache (subclass / group / subgroup level) */
export interface CpcEntry {
  code: string;
  cnt: number;
  title?: string;
}

export interface CpcMappingResult {
  codes: string[];
  titles: Record<string, string>;
}

// ─── BigQuery client configuration ──────────────────────────────────────────

export interface BigQueryClientConfig {
  projectId: string;
  keyFilename?: string;
  dataset: string;
  location: string;
  maxBytesBilled: string;
  timeoutMs: number;
  scopes: string[];
}

export type BigQueryClientOptions = Partial<BigQueryClientConfig>;
