// Zod schema for PatentData — used at the BigQuery/mock boundary to validate
// the exact runtime shape expected by the 8 patent indicators.
// Source of truth for both the runtime validator (validatePatentData) and
// the TypeScript types used across src/lib/patent/ and work-on-evolution/write/patent/.

import { z } from 'zod';

export const CpcDistributionEntrySchema = z.object({
  cpc: z.string(),
  count: z.number(),
});

export const YearlyClassificationSchema = z.object({
  year: z.number(),
  cpcCodes: z.array(z.string()),
});

export const CitationDataSchema = z.object({
  totalForwardCitations: z.number(),
  patentCount: z.number(),
});

export const ClaimsTimelineEntrySchema = z.object({
  year: z.number(),
  avgIndependentClaims: z.number(),
});

export const AssigneeDataSchema = z.object({
  uniqueAssignees: z.number(),
  totalPatents: z.number(),
});

export const GeoDataSchema = z.object({
  jurisdictionCount: z.number(),
  jurisdictions: z.array(z.string()),
});

export const SectorDataSchema = z.object({
  uniqueSections: z.number(),
  uniqueClasses: z.number(),
});

export const ExpirationDataSchema = z.object({
  expiredCount: z.number(),
  totalPatents: z.number(),
});

export const PatentDataSchema = z.object({
  totalPatents: z.number().min(0),
  cpcDistribution: z.array(CpcDistributionEntrySchema),
  yearlyClassifications: z.array(YearlyClassificationSchema),
  citationData: CitationDataSchema,
  claimsTimeline: z.array(ClaimsTimelineEntrySchema),
  assigneeData: AssigneeDataSchema,
  geoData: GeoDataSchema,
  sectorData: SectorDataSchema,
  expirationData: ExpirationDataSchema,
  _queryErrors: z.record(z.string(), z.string()).optional(),
});

// Inferred types — these are the source of truth, re-exported from src/types/patent.mts
export type CpcDistributionEntry = z.infer<typeof CpcDistributionEntrySchema>;
export type YearlyClassification = z.infer<typeof YearlyClassificationSchema>;
export type CitationData = z.infer<typeof CitationDataSchema>;
export type ClaimsTimelineEntry = z.infer<typeof ClaimsTimelineEntrySchema>;
export type AssigneeData = z.infer<typeof AssigneeDataSchema>;
export type GeoData = z.infer<typeof GeoDataSchema>;
export type SectorData = z.infer<typeof SectorDataSchema>;
export type ExpirationData = z.infer<typeof ExpirationDataSchema>;
export type PatentData = z.infer<typeof PatentDataSchema>;
