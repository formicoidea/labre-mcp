// Solution-side evolution types (discriminated from capability evolution).
//
// Source of truth: src/schemas/inputs.schema.mts (inputs) and
// src/schemas/results.schema.mts (results).

export type {
  WardleyPhase,
  PhaseLabel,
  SolutionInput,
} from '../schemas/inputs.schema.mjs';

export type {
  PropertyEvaluation,
  SolutionEvolutionResult,
} from '../schemas/results.schema.mjs';
