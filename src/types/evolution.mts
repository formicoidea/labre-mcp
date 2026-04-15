// Core evolution evaluation types.
//
// Transcribed from JSDoc @typedef blocks in
// src/work-on-evolution/strategies/capacity/base-strategy.mjs.

/** Nature d'une capacité au sens Wardley. */
export type CapabilityNature =
  | 'activite'
  | 'pratique'
  | 'connaissance'
  | 'donnee'
  | 'none';

/**
 * Structured result returned by every capacity evolution strategy.
 * Validated at runtime by BaseStrategy.validateResult().
 */
export interface EvolutionResult {
  /** Evolution position (0–1 competitive, outside = extra-competitive) */
  evolution: number;
  /** Confidence score (0–1) */
  confidence: number;
  /** Strategy identifier string */
  method: string;
  /** Trace of reasoning steps — strategy-specific format (optional) */
  trace?: unknown[];
}

/**
 * Component input shape shared by all strategies.
 * All fields except `name` are optional — strategies consume only what they need.
 */
export interface ComponentInput {
  /** Component name */
  name: string;
  /** Certitude score (0–1) */
  certitude?: number;
  /** Ubiquity score (0–1) */
  ubiquity?: number;
  /** Wonder publication proportion */
  wonder?: number;
  /** Build publication proportion */
  build?: number;
  /** Operate publication proportion */
  operate?: number;
  /** Usage publication proportion */
  usage?: number;
  /** Free-text component description */
  description?: string;
  /** Alias for description (some callers pass `context` instead) */
  context?: string;
  /** Optional date for context (when the component is to be observed) */
  date?: string | Date | number;
  /** Underlying capability identified upstream by the orchestrator */
  capability?: string;
  /** Capability nature */
  nature?: CapabilityNature;
  /** Additional strategy-specific data */
  metadata?: Record<string, unknown>;
}
