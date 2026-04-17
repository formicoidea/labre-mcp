// Core evolution evaluation types.
//
// Source of truth: src/schemas/inputs.schema.mts (inputs) and
// src/schemas/results.schema.mts (results).
// This file re-exports the inferred types for convenience.

export type {
  CapabilityNature,
  ComponentInput,
  PhaseDistribution,
} from '../schemas/inputs.schema.mjs';

export type { EvolutionResult } from '../schemas/results.schema.mjs';
