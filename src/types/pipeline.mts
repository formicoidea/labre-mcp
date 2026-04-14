// Enriched pipeline types (capability pivot + SotA/legacy discovery).
//
// Transcribed from JSDoc @typedef in
// src/work-on-evolution/pipeline/pipeline-enriched.mjs.

import type { CapabilityNature } from './evolution.mjs';
import type { EvaluationsMap, RoutingMetadata } from './routing.mjs';

/** Résultat du capability pivot — étape 1 du pipeline enrichi. */
export interface CapabilityPivotResult {
  /** Abstract capability name (e.g. "Manage customer relationships") */
  capabilityName: string;
  /** Capability nature (activity/practice/data/knowledge) */
  nature: CapabilityNature;
  /** Evolution score [0, 1] */
  evolution: number;
  /** Confidence in the evolution score [0, 1] */
  confidence: number;
  /** Strategy method that produced the score */
  method: string;
  /** Full evaluation results from all strategies */
  evaluations: EvaluationsMap;
  /** Wardley component type metadata */
  wardleyType: Record<string, unknown>;
  /** Routing metadata from the evaluation */
  routing: RoutingMetadata;
}

/** Solution nommée découverte par le LLM (SotA ou legacy). */
export interface DiscoveredSolution {
  /** Solution name (e.g. "Kubernetes", "Docker Swarm") */
  name: string;
  /** Brief description of the solution */
  description: string;
  /** Whether this is the SotA or legacy solution */
  role: 'sota' | 'legacy';
}

/** Résultat de la phase de découverte SotA/legacy. */
export interface SolutionDiscoveryResult {
  /** State-of-the-art / cutting-edge solution */
  sota: DiscoveredSolution | null;
  /** Legacy / established / older solution */
  legacy: DiscoveredSolution | null;
  /** Capability name used for discovery */
  capabilityUsed: string;
  /** Confidence in the discovery (0–1) */
  confidence: number;
}
