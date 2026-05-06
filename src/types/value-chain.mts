// Types for the value-chain (`write:chain:*`) pipeline.
//
// Covers Wardley cycle phases 1–2 (prompt context + chain generation with
// lisibility-only positioning). Later pipeline steps (write:evolution,
// climate analysis, doctrine, gameplays) consume a PositionedValueChain but
// are out of scope here.
//
// Naming note: `WardleyPhaseKey` is the keyed form aligned with
// PHASE_CENTROIDS in src/schemas/inputs.schema.mjs. The numeric `WardleyPhase`
// in that same file is a different representation and must not be confused.

import type { IdentifyCapabilityInput } from '../schemas/identify-capability.schema.mjs';
import type { CapabilityNature } from '../schemas/inputs.schema.mjs';

export type Temporality = 'past' | 'present' | 'future';

export interface ChainMetadata {
  /**
   * Map title written in the same language as the original NL command.
   * Composed by the LLM (e.g. "Chaîne de valeur de Stripe", "Value chain of
   * an online payment provider", "Wertschöpfungskette von Stripe").
   */
  title: string;
  angle: string;
  scope: string;
  objective: string;
  imperatives: string[];
  temporality: Temporality;
  contextSummary: string;
}

// Aligned with PHASE_CENTROIDS keys in src/schemas/inputs.schema.mts.
export type WardleyPhaseKey = 'phase1' | 'phase2' | 'phase3' | 'phase4';

// OWM DSL component type — reused from identify-capability.
export type OwmComponentType = NonNullable<IdentifyCapabilityInput['type']>;

// Chain-level role of a component. Distinct from the OWM `type` enum:
// - `anchor`: the stakeholder beneficiary, fixed at [0.95, 0.5]
// - `need`: a direct need of the anchor
// - `capability`: any component that serves needs directly or indirectly
export type ChainRole = 'anchor' | 'need' | 'capability';

export interface ValueChainComponent {
  name: string;
  type: OwmComponentType;
  nature?: CapabilityNature;
  description?: string;
  context?: string;
  role: ChainRole;
  // Rough X coordinate proposed by LLM #2 (generate-chain) for VISUAL
  // CLARITY of the chain. NOT an evolution-maturity estimate — the
  // evolution axis is hidden at write:chain:* stage and only revealed in
  // phase 3 by estimateEvolution. The deterministic adjust-x step keeps
  // the final X within ±0.10 of this hint.
  xHint?: number;
}

// Directed dependency. A consumes B (A needs B to exist). In OWM the edge is
// rendered as `A -> B`. The consumer (A) sits higher in visibility than the
// consumed (B).
export interface DependencyLink {
  from: string;
  to: string;
}

export interface RawValueChain {
  metadata: ChainMetadata;
  components: ValueChainComponent[];
  links: DependencyLink[];
}

// Relative label offset in OWM coordinates. `{ dx: 0, dy: 0 }` places the
// lower-right corner of the label text at the node center.
export interface LabelOffset {
  dx: number;
  dy: number;
}

export interface PositionedComponent extends ValueChainComponent {
  visibility: number; // Y, [0, 1]
  evolution: number;  // X, [0, 1]
  label: LabelOffset;
}

export interface PositionedValueChain {
  metadata: ChainMetadata;
  components: PositionedComponent[];
  links: DependencyLink[];
}
