// Classification gate types.
//
// Transcribed from JSDoc @typedef in
// src/work-on-evolution/write/routing/classification-gate.mjs.

/** Espace économique déterminé par le classification gate. */
export type EconomicSpace = 'social_good' | 'common_good' | 'economic';

/**
 * Résultat du classification gate : détermine si la demande relève
 * de l'espace économique ou doit être re-questionnée.
 */
export interface ClassificationResult {
  space: EconomicSpace;
  /** Human-readable explanation */
  reason: string;
  /** true if the user should be re-questioned */
  requiresReQuestion: boolean;
}
