// Shared vocabulary of the placement bench (CH-27).
//
// The bench answers ONE question, the falsification test the phase-2 audit
// posed: does a markdown skill (+ a small deterministic geometry CLI) reach the
// same correct-placement rate, with the same traceability, as the engine's real
// placement strategy? Everything here is the vocabulary that question needs —
// no business logic, no I/O.
//
// Nothing in this folder writes to `src/`. The bench CONSUMES the engine
// through its published seams (`#core/*`, `#frameworks/*`, `#lib/*`) and never
// patches it.

import type { RunClock } from '#core/recipe/recipe-runner.mjs';
import type { LLMCall } from '#types/llm.mjs';

// ── The evolution axis ─────────────────────────────────────────────────
//
// The four Wardley stages and their boundaries, copied VERBATIM from the
// engine's own prompt (`prompts/historical-evolution.*.system.md`):
//   Genesis [0, 0.18] | Custom [0.18, 0.40] | Product [0.40, 0.70] | Commodity [0.70, 1.0]
// Sharing the boundaries with the strategy under test is deliberate: the
// stage-agreement metric must not measure a disagreement about where a stage
// begins.

export type EvolutionStage = 'genesis' | 'custom' | 'product' | 'commodity';

export const STAGE_UPPER_BOUNDS: ReadonlyArray<readonly [EvolutionStage, number]> = [
  ['genesis', 0.18],
  ['custom', 0.4],
  ['product', 0.7],
  ['commodity', 1],
];

export function stageOf(evolution: number): EvolutionStage {
  for (const [stage, upper] of STAGE_UPPER_BOUNDS) {
    if (evolution < upper) return stage;
  }
  return 'commodity';
}

// ── The gold set ───────────────────────────────────────────────────────

/**
 * A map, stripped of EVERY evolution coordinate.
 *
 * This is the only view of the map any posture may see. The stripping is
 * structural, not a mask: the field does not exist in the record, so no
 * posture — and no future contributor's shortcut — can read the answer out of
 * the neighbourhood. Visibility survives because it is the OTHER axis (the
 * value chain), authored independently of the axis under measurement.
 */
export interface GoldMapNode {
  id: string;
  label: string;
  type: 'anchor' | 'component';
  /** Canonical visibility: 0 = top of the value chain (closest to the user). */
  visibility: number;
}

export interface GoldMapEdge {
  /** Component that consumes (the more visible end). */
  consumer: string;
  /** Component that is consumed (the less visible end). */
  supplier: string;
}

export interface GoldMap {
  key: string;
  title: string;
  /** One-line business context, identical for every posture. */
  context: string;
  sourceFile: string;
  nodes: GoldMapNode[];
  edges: GoldMapEdge[];
}

export interface GoldCase {
  id: string;
  mapKey: string;
  /** Component id inside the map (canonical slug). */
  componentId: string;
  /** Component label, as the map's author wrote it. */
  component: string;
  /** Semantic hint. Empty when the source map carries none — never guessed. */
  description: string;
  /** Business context (map-level), identical for every posture. */
  context: string;
  /** Reference date the placement is asked about. */
  date: string;
  truth: {
    evolution: number;
    stage: EvolutionStage;
  };
}

export interface GoldSet {
  /** How this file was produced, so a reader can regenerate it. */
  generator: string;
  generatedFrom: string[];
  /** |predicted - truth| at or below this counts as a correct placement. */
  tolerance: number;
  maps: Record<string, GoldMap>;
  cases: GoldCase[];
}

// ── Postures ───────────────────────────────────────────────────────────

/**
 * What every posture must hand back. `evolution` is the measured answer;
 * everything else is the TRACE — the second half of the falsification test.
 */
export interface PostureAnswer {
  evolution: number;
  confidence: number;
  /** Human-readable "why", as the posture produced it (never re-written). */
  rationale: string;
  /** Everything needed to replay the call and audit the answer. */
  trace: PostureTrace;
}

export interface PostureTrace {
  /** Verbatim inputs of every LLM call the posture made, in order. */
  llmCalls: Array<{ system: string; user: string; response: string }>;
  /**
   * Structured, machine-readable rationale — typed fields, not prose.
   * `null` when the posture produces none (that is a traceability finding,
   * not an error).
   */
  structured: Record<string, unknown> | null;
  /**
   * Output of the deterministic, non-LLM part of the posture, if any.
   * Recomputable offline from the gold set alone.
   */
  deterministic: Record<string, unknown> | null;
}

export interface PostureDeps {
  /** The SINGLE LLM call shared by every posture — equity is the validity condition. */
  llmCall: LLMCall;
  /** Injected clock / id factory (CH-12 convention), so a run is replayable. */
  clock: Required<RunClock>;
  /** The gold set, for postures that need the map structure. */
  goldSet: GoldSet;
}

export interface Posture {
  /** `A` | `B` | `C` — the three arms of the falsification test. */
  id: string;
  label: string;
  /** How many LLM calls one case costs. Used for the pre-run cost preview. */
  llmCallsPerCase: number;
  run(goldCase: GoldCase, deps: PostureDeps): Promise<PostureAnswer>;
}

// ── Results ────────────────────────────────────────────────────────────

export interface CaseOutcome {
  caseId: string;
  postureId: string;
  /** null when the posture failed (parse error, provider error, …). */
  answer: PostureAnswer | null;
  error: string | null;
  truth: { evolution: number; stage: EvolutionStage };
  /** |predicted - truth| on the evolution axis, null on failure. */
  absoluteError: number | null;
  /** absoluteError <= tolerance. */
  correct: boolean;
  /** Predicted stage equals the reference stage. */
  stageCorrect: boolean;
  latencyMs: number;
}

/** The four mechanical traceability criteria (see README § Traçabilité). */
export interface TraceabilityScore {
  /** The answer carries a machine-readable rationale, not only prose. */
  structuredRationale: boolean;
  /** Every LLM input is recorded verbatim, so the call can be replayed. */
  replayableInputs: boolean;
  /** The non-LLM part of the answer is recomputable offline, deterministically. */
  deterministicPart: boolean;
  /** The rationale is attributed — who (which method) said what. */
  attributed: boolean;
  verdict: 'oui' | 'partiel' | 'non';
  /** Verbatim evidence for the verdict, one line per criterion. */
  evidence: string[];
}

export interface PostureReport {
  postureId: string;
  label: string;
  cases: number;
  /** Cases that produced an answer at all. */
  answered: number;
  correct: number;
  correctRate: number;
  stageCorrect: number;
  stageCorrectRate: number;
  /** Mean absolute error over answered cases. */
  meanAbsoluteError: number | null;
  medianAbsoluteError: number | null;
  llmCalls: number;
  totalLatencyMs: number;
  /** Per source map — the reference is not equally trustworthy on all three. */
  byMap: Record<string, { cases: number; correct: number }>;
  traceability: TraceabilityScore;
}

export interface BenchRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** `stub` (offline) or the resolved provider/model of the real run. */
  llm: { provider: string; model: string; mode: 'stub' | 'live' };
  tolerance: number;
  caseIds: string[];
  plannedLlmCalls: number;
  observedLlmCalls: number;
  outcomes: CaseOutcome[];
  reports: PostureReport[];
}
