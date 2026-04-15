// Wardley Map (.wm) parsing and evaluation types
//
// Used by evaluate-map.mts (parser + evaluator).

export interface WardleyAnchor {
  name: string;
  visibility: number;
  maturity: number;
  raw: string;
}

export interface WardleyComponent {
  name: string;
  visibility: number;
  maturity: number;
  decorators: string[];
  label: [number, number] | null;
  raw: string;
}

export interface WardleyEvolve {
  name: string;
  target: number;
  raw: string;
}

export interface WardleyNote {
  text: string;
  visibility: number;
  maturity: number;
  raw: string;
}

export interface WardleyLink {
  from: string;
  to: string;
  label: string | null;
  raw: string;
}

export interface WardleyPipelineDeclaration {
  raw: string;
}

export interface ParsedWardleyMap {
  title: string | null;
  style: string | null;
  anchors: WardleyAnchor[];
  components: WardleyComponent[];
  links: WardleyLink[];
  evolves: WardleyEvolve[];
  notes: WardleyNote[];
  pipelines: WardleyPipelineDeclaration[];
  other: string[];
}

export interface MapItemEvaluation {
  name: string;
  type: 'anchor' | 'component';
  originalMaturity: number;
  newMaturity: number | null;
  classification: string;
  strategies: Record<string, { evolution: number; confidence: number }> | null;
  skipped: boolean;
  reason?: string;
  /** Difference between newMaturity and originalMaturity (added during reporting) */
  delta?: number;
}

/** Options for evaluateMapComponents / evaluateMapFile */
export interface EvaluateMapOptions {
  strategy?: string;
  context?: string;
  updateFile?: boolean;
  msg?: (id: string, params?: Record<string, unknown>) => string;
  [key: string]: unknown;
}
