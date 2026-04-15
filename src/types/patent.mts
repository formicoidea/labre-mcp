// Patent domain types — used by lib/patent/* and work-on-evolution/patent/*
//
// Reflects the exact runtime shape produced by emptyPatentData() and
// expected by the 8 indicator functions in patent-indicators.mts.

// ─── PatentData (raw input to indicators) ──────────────────────────────────

export interface CpcDistributionEntry {
  cpc: string;
  count: number;
}

export interface YearlyClassification {
  year: number;
  cpcCodes: string[];
}

export interface CitationData {
  totalForwardCitations: number;
  patentCount: number;
}

export interface ClaimsTimelineEntry {
  year: number;
  avgIndependentClaims: number;
}

export interface AssigneeData {
  uniqueAssignees: number;
  totalPatents: number;
}

export interface GeoData {
  jurisdictionCount: number;
  jurisdictions: string[];
}

export interface SectorData {
  uniqueSections: number;
  uniqueClasses: number;
}

export interface ExpirationData {
  expiredCount: number;
  totalPatents: number;
}

export interface PatentData {
  totalPatents: number;
  cpcDistribution: CpcDistributionEntry[];
  yearlyClassifications: YearlyClassification[];
  citationData: CitationData;
  claimsTimeline: ClaimsTimelineEntry[];
  assigneeData: AssigneeData;
  geoData: GeoData;
  sectorData: SectorData;
  expirationData: ExpirationData;
  /** Optional metadata on partial query failures */
  _queryErrors?: Record<string, string>;
}

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
