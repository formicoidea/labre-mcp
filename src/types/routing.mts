// Routing & mode-router types.
//
// Transcribed from JSDoc @typedef in
// src/work-on-evolution/write/routing/mode-router.mjs, with the conditional
// pipeline fields promoted to a proper discriminated union.

import type { EvolutionResult } from './evolution.mjs';

/** Métadonnées de routing solution/capability émises par le router. */
export interface RoutingMetadata {
  type: 'solution' | 'capability';
  confidence: number;
  method?: string;
  evalMode?: 'fast' | 'thorough';
}

/** Payload d'évaluations : map strategy name → résultat (ou erreur). */
export type EvaluationsMap = Record<string, EvolutionResult | { error: string }>;

// ─── Component type detection ──────────────────────────────────────────────

export type ComponentTypeKind = 'solution' | 'capability';

export interface WebSearchEvidence {
  type: string;
  description?: string;
  source?: string;
  supports?: string;
}

export interface WebSearchReference {
  title: string;
  url: string;
  snippet?: string;
}

export interface ComponentTypeDetection {
  /** Some callers use `type`, others `classification` — both optional, at least one is set */
  type?: ComponentTypeKind | string;
  classification?: ComponentTypeKind | string;
  confidence: number;
  method: string;
  reasoning?: string;
  isSolution?: boolean;
  evidence?: WebSearchEvidence[] | undefined;
  references?: WebSearchReference[] | undefined;
  /** Loose extension fields tolerated by various callers */
  [key: string]: unknown;
}

export type WebSearchVerificationResult = ComponentTypeDetection;
