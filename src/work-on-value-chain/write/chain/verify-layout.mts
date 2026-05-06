// Step 7 of the write:chain:* pipeline — collision-aware label
// correction loop driven by a weighted score.
//
// Slots between place-labels (step 6) and emit-owm (step 8). For each
// iteration:
//   1. Re-emit the OWM DSL with the current label offsets.
//   2. Render via the OwmRenderAdapter (cli-owm by default).
//   3. Parse the SVG into bboxes, edges and canvas dimensions.
//   4. Detect all overlap classes:
//        - hard : label↔label, label↔component, label↔canvas-overflow
//        - soft : label↔third-party-edge crossings
//   5. If clean → done. Otherwise pick the LABEL with the highest
//      total weighted score, score the eight candidate offsets,
//      apply the candidate that minimises the post-move score.
//
// Score = HARD_PENALTY × (label-label + label-component + label-canvas)
//       + SOFT_PENALTY × edge-crossings
//
// Only LABEL offsets are correctable here. Component circle positions
// (X, Y) and anchor positions are upstream concerns of compute-
// visibility / adjust-x and stay frozen at this stage.
//
// Failure mode: if `adapter.render` throws (cli-owm absent, parser
// crash, etc.), the chain is returned unmodified with `report.skipped
// = true` and a warn on the ambient collector. The pipeline always
// emits SOMETHING — collision correction is best-effort, never
// blocking.

import { generateChainOwmSyntax, type EmitOwmOptions } from './emit-owm.mjs';
import type {
  LabelOffset,
  PositionedComponent,
  PositionedValueChain,
} from '../../../types/value-chain.mjs';
import type { OwmRenderAdapter } from '../../../lib/owm/render-adapter.mjs';
import { candidatesFor } from '../../../lib/owm/candidate-offsets.mjs';
import {
  parseSvgGeometry,
  type SvgGeometry,
} from '../../../lib/owm/svg-bbox-parser.mjs';
import {
  detectAllOverlaps,
  rectGap,
  type Overlap,
} from '../../../lib/owm/overlap-detector.mjs';
import { getCurrentCollector } from '../../../lib/degradation/index.mjs';

// ─── Constants ──────────────────────────────────────────────────────────

/** Hard cap on the correction loop. Five passes empirically converge
 *  on chains up to ~25 components without runaway oscillation. */
export const MAX_VERIFY_ITERATIONS = 5;

/** Maximum number of labels the post-greedy local-refinement pass
 *  will touch (Phase 5e). Each refined label costs ~77 trial renders
 *  so this caps end-to-end latency at ~2 s per chain. The pass picks
 *  the most-cramped labels first (smallest neighbour gap). */
export const MAX_REFINE_LABELS = 5;
/** Half-range of the X perturbation window in pixels (Phase 5e). */
export const REFINE_X_RANGE = 5;
/** Half-range of the Y perturbation window in pixels (Phase 5e). */
export const REFINE_Y_RANGE = 3;

/** Maximum number of components the Phase 5f fallback may nudge in
 *  total. Each nudge re-runs the inner label loop so cost grows
 *  multiplicatively. */
export const MAX_COMPONENT_NUDGES = 3;
/** Magnitude of the cardinal X nudge applied to an offending
 *  component. Intentionally smaller than `BAND_HALF = 0.10` from
 *  adjust-x so we stay well inside the LLM-proposed tolerance band. */
export const COMP_NUDGE_X_STEP = 0.03;
/** Magnitude of the cardinal Y nudge. Conservative — well below the
 *  `step/4` upper bound for typical chain lengths (L < 25 ⇒
 *  step/4 > 0.0085). */
export const COMP_NUDGE_Y_STEP = 0.02;
/** Strict gap (in normalised Y units) preserved between a parent and
 *  a child after a nudge. Mirrors `EDGE_MIN_GAP` in compute-visibility
 *  but kept local to verify-layout so this module doesn't import an
 *  upstream constant. */
const NUDGE_EDGE_GAP_Y = 0.01;
/** Global X bounds — match `LEFT_BOUND` / `RIGHT_BOUND` in adjust-x. */
const NUDGE_X_LOW = 0.10;
const NUDGE_X_HIGH = 0.90;
/** Global Y bounds — match `Y_MIN` / `ANCHOR_VISIBILITY` in compute-visibility. */
const NUDGE_Y_LOW = 0.10;
const NUDGE_Y_HIGH = 0.95;
/** Width of the LLM-proposed tolerance band (`xHint ± BAND_HALF`).
 *  A nudged component must remain inside this band to respect
 *  adjust-x's contract. */
const NUDGE_XHINT_BAND = 0.10;

/** Weight applied per unit of severity for hard overlap kinds. */
export const HARD_PENALTY = 1000;
/** Weight for the soft "labels too close" violation — must outrank
 *  edge crossings and axis crossings because visual readability of
 *  the labels themselves comes first. */
export const SOFT_SPACING_PENALTY = 100;
/** Weight for the soft "label crossed by a third-party edge"
 *  violation. */
export const SOFT_EDGE_PENALTY = 10;
/** Weight for the soft "label sits on a phase-boundary axis line"
 *  violation. Lowest priority among soft kinds. */
export const SOFT_AXIS_PENALTY = 1;

/** Per-kind penalty table. Order in the score :
 *    HARD (label-label, component-label, label-canvas)
 *  > SOFT_SPACING
 *  > SOFT_EDGE
 *  > SOFT_AXIS
 *
 *  Pair kinds we don't handle (anchor-* / component-component) are
 *  weighted at 0 — they exist in the OverlapKind union for upstream
 *  detector reasons but verify-layout treats them as zero-cost. */
const PENALTIES: Record<Overlap['kind'], number> = {
  'label-label':         HARD_PENALTY,
  'component-label':     HARD_PENALTY,
  'label-canvas':        HARD_PENALTY,
  'label-spacing':       SOFT_SPACING_PENALTY,
  'label-edge':          SOFT_EDGE_PENALTY,
  'label-axis':          SOFT_AXIS_PENALTY,
  'anchor-anchor':       0,
  'anchor-component':    0,
  'anchor-label':        0,
  'component-component': 0,
};

const HARD_KINDS: ReadonlySet<Overlap['kind']> = new Set([
  'label-label',
  'component-label',
  'label-canvas',
]);

// ─── Types ──────────────────────────────────────────────────────────────

export interface VerifyReport {
  /** Render cycles consumed. 0 means the initial layout was already clean. */
  iterations: number;
  /** Names of components whose label offset was moved by the loop. */
  modifiedLabels: string[];
  /** Names of components whose position was nudged by the loop's
   *  fallback pass (Phase 5f). Empty until that pass is implemented. */
  movedComponents: string[];
  /** Hard violations remaining at end of loop. 0 is the happy path. */
  unresolvedHard: number;
  /** Label-spacing soft violations remaining (labels < 16 px apart). */
  unresolvedSpacing: number;
  /** Label-edge soft violations remaining (third-party edge crossing). */
  unresolvedEdge: number;
  /** Label-axis soft violations remaining (label on a phase boundary). */
  unresolvedAxis: number;
  /** True iff the renderer was unavailable and the loop was skipped. */
  skipped: boolean;
}

export interface VerifyLayoutResult {
  chain: PositionedValueChain;
  report: VerifyReport;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function warn(message: string): void {
  const collector = getCurrentCollector();
  if (collector) {
    collector.recordError('write-chain:verify-layout', new Error(message), {
      recoverable: true,
      severity: 'warning',
    });
  }
}

function knownNames(chain: PositionedValueChain): Set<string> {
  return new Set(chain.components.map(c => c.name));
}

function withLabel(
  chain: PositionedValueChain,
  name: string,
  label: LabelOffset,
): PositionedValueChain {
  return {
    metadata: chain.metadata,
    links: chain.links,
    components: chain.components.map<PositionedComponent>(c =>
      c.name === name ? { ...c, label } : c,
    ),
  };
}

/** Apply a new (X, Y) position to a single component without
 *  touching its label, role, phase, etc. Used by the Phase 5f nudge
 *  fallback. */
function withPosition(
  chain: PositionedValueChain,
  name: string,
  evolution: number,
  visibility: number,
): PositionedValueChain {
  return {
    metadata: chain.metadata,
    links: chain.links,
    components: chain.components.map<PositionedComponent>(c =>
      c.name === name ? { ...c, evolution, visibility } : c,
    ),
  };
}

interface BreakdownCounts {
  hard: number;
  spacing: number;
  edge: number;
  axis: number;
}

interface RenderProbe {
  overlaps: Overlap[];
  geometry: SvgGeometry;
  totalScore: number;
  counts: BreakdownCounts;
}

function summarise(overlaps: readonly Overlap[]): { totalScore: number; counts: BreakdownCounts } {
  const counts: BreakdownCounts = { hard: 0, spacing: 0, edge: 0, axis: 0 };
  let totalScore = 0;
  for (const ov of overlaps) {
    const w = PENALTIES[ov.kind] ?? 0;
    if (w === 0) continue;
    totalScore += w * ov.severity;
    if (HARD_KINDS.has(ov.kind))         counts.hard++;
    else if (ov.kind === 'label-spacing') counts.spacing++;
    else if (ov.kind === 'label-edge')    counts.edge++;
    else if (ov.kind === 'label-axis')    counts.axis++;
  }
  return { totalScore, counts };
}

/** Render the chain, parse geometry, detect overlaps, summarise score.
 *  Returns null if the adapter throws — the caller decides whether to
 *  skip the loop or score the candidate as worse-than-current. */
function probe(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  adapter: OwmRenderAdapter,
  names: ReadonlySet<string>,
): RenderProbe | null {
  let dsl: string;
  let svg: string;
  try {
    dsl = generateChainOwmSyntax(chain, emitOpts);
    svg = adapter.render(dsl);
  } catch {
    return null;
  }
  const geometry = parseSvgGeometry(svg, names);
  const overlaps = detectAllOverlaps(geometry);
  const { totalScore, counts } = summarise(overlaps);
  return { geometry, overlaps, totalScore, counts };
}

/** Pick the label whose label-bearing overlaps weigh the most in the
 *  current score. Returns null when no overlap involves a label
 *  (typical when only out-of-scope component-component pairs remain). */
function worstOffendingLabel(overlaps: readonly Overlap[]): string | null {
  const scoreByName = new Map<string, number>();
  for (const ov of overlaps) {
    const weight = PENALTIES[ov.kind] ?? 0;
    if (weight === 0) continue;
    if (ov.a.kind === 'label') {
      scoreByName.set(ov.a.name, (scoreByName.get(ov.a.name) ?? 0) + weight * ov.severity);
    }
    if (ov.b.kind === 'label') {
      scoreByName.set(ov.b.name, (scoreByName.get(ov.b.name) ?? 0) + weight * ov.severity);
    }
  }
  if (scoreByName.size === 0) return null;
  let bestName: string | null = null;
  let bestScore = -Infinity;
  for (const [name, score] of scoreByName) {
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  return bestName;
}

interface CandidateScore {
  offset: LabelOffset;
  totalScore: number;
}

/** Try every candidate offset for a single component, render, score
 *  by HARD/SOFT-weighted total. Returns the best candidate (which may
 *  be the current one if no improvement is found). */
function bestCandidateFor(
  componentName: string,
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  adapter: OwmRenderAdapter,
  names: ReadonlySet<string>,
): CandidateScore | null {
  let best: CandidateScore | null = null;
  for (const candidate of candidatesFor(componentName)) {
    const trial = withLabel(chain, componentName, candidate);
    const result = probe(trial, emitOpts, adapter, names);
    if (result === null) continue;
    if (best === null || result.totalScore < best.totalScore) {
      best = { offset: candidate, totalScore: result.totalScore };
    }
  }
  return best;
}

function sameOffset(a: LabelOffset, b: LabelOffset): boolean {
  return a.dx === b.dx && a.dy === b.dy;
}

// ─── Phase 5e — local refinement ───────────────────────────────────────

/** Smallest `rectGap` from `lbl` to any other label in `geometry`.
 *  Returns `Number.MAX_SAFE_INTEGER` when the label is alone — used
 *  as a sentinel meaning "no neighbour to dodge". */
function minGapToNeighbour(
  geometry: SvgGeometry,
  labelName: string,
): number {
  const labels = geometry.items.filter(it => it.kind === 'label');
  const self = labels.find(it => it.name === labelName);
  if (!self) return Number.MAX_SAFE_INTEGER;
  let best = Number.POSITIVE_INFINITY;
  for (const other of labels) {
    if (other.name === labelName) continue;
    const gap = rectGap(self.bbox, other.bbox);
    if (gap < best) best = gap;
  }
  return Number.isFinite(best) ? best : Number.MAX_SAFE_INTEGER;
}

/**
 * Phase 5e — for each label (capped at `MAX_REFINE_LABELS`, most-cramped
 * first), try every (Δx, Δy) ∈ [-REFINE_X_RANGE..+REFINE_X_RANGE] ×
 * [-REFINE_Y_RANGE..+REFINE_Y_RANGE] step 1 px and apply the
 * perturbation that:
 *   1. does NOT degrade the total score, AND
 *   2. strictly increases the minimum gap to the nearest other label.
 *
 * Returns the refined chain plus the names of labels actually moved.
 * Pure modulo the adapter — null adapter responses are treated as
 * "trial degraded" and skipped, never abort the pass.
 */
function refineLocally(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  adapter: OwmRenderAdapter,
  names: ReadonlySet<string>,
): { chain: PositionedValueChain; refined: string[] } {
  const baseline = probe(chain, emitOpts, adapter, names);
  if (baseline === null) return { chain, refined: [] };

  // Rank labels by ascending min-gap so the most-cramped get refined
  // first within the MAX_REFINE_LABELS budget.
  const labelItems = baseline.geometry.items.filter(it => it.kind === 'label');
  const ranked = labelItems
    .map(it => ({ name: it.name, gap: minGapToNeighbour(baseline.geometry, it.name) }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, MAX_REFINE_LABELS);

  let current = chain;
  let currentScore = baseline.totalScore;
  const refined: string[] = [];

  for (const { name } of ranked) {
    const targetComp = current.components.find(c => c.name === name);
    if (!targetComp) continue;
    const baseDx = targetComp.label.dx;
    const baseDy = targetComp.label.dy;

    let bestOffset = targetComp.label;
    let bestScore = currentScore;
    // Re-probe to compute the current min-gap with respect to the
    // up-to-date `current` chain (other labels may have moved during
    // earlier iterations of this loop).
    const fresh = probe(current, emitOpts, adapter, names);
    let bestGap = fresh ? minGapToNeighbour(fresh.geometry, name) : 0;

    for (let dx = -REFINE_X_RANGE; dx <= REFINE_X_RANGE; dx++) {
      for (let dy = -REFINE_Y_RANGE; dy <= REFINE_Y_RANGE; dy++) {
        if (dx === 0 && dy === 0) continue;
        const trial = withLabel(current, name, { dx: baseDx + dx, dy: baseDy + dy });
        const result = probe(trial, emitOpts, adapter, names);
        if (result === null) continue;
        if (result.totalScore > bestScore) continue;
        const trialGap = minGapToNeighbour(result.geometry, name);
        // Take if score is strictly better, or score is tied and gap
        // is strictly larger.
        if (result.totalScore < bestScore
         || (result.totalScore === bestScore && trialGap > bestGap)) {
          bestOffset = { dx: baseDx + dx, dy: baseDy + dy };
          bestScore = result.totalScore;
          bestGap = trialGap;
        }
      }
    }

    if (!sameOffset(bestOffset, targetComp.label)) {
      current = withLabel(current, name, bestOffset);
      currentScore = bestScore;
      refined.push(name);
    }
  }

  return { chain: current, refined };
}

// ─── Inner label loop (extracted so Phase 5f can re-run it) ────────────

interface LabelLoopResult {
  chain: PositionedValueChain;
  modified: string[];
  iterations: number;
  counts: BreakdownCounts;
  totalScore: number;
  /** True iff the adapter was unavailable on the first probe. */
  skipped: boolean;
}

/** Run the discrete greedy + Phase 5e refinement on `chain`. Returns
 *  the post-loop chain and a breakdown of what changed and what
 *  remains. When the adapter throws on the very first probe, returns
 *  `skipped: true` and the input chain unchanged. */
function runLabelLoop(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  adapter: OwmRenderAdapter,
  names: ReadonlySet<string>,
): LabelLoopResult {
  const modified: string[] = [];
  let current = chain;
  let lastCounts: BreakdownCounts = { hard: 0, spacing: 0, edge: 0, axis: 0 };
  let lastScore = 0;
  let iterations = 0;

  for (let iter = 0; iter < MAX_VERIFY_ITERATIONS; iter++) {
    const baseline = probe(current, emitOpts, adapter, names);
    if (baseline === null) {
      return {
        chain,
        modified: [],
        iterations,
        counts: { hard: 0, spacing: 0, edge: 0, axis: 0 },
        totalScore: 0,
        skipped: true,
      };
    }
    lastCounts = baseline.counts;
    lastScore = baseline.totalScore;

    if (baseline.overlaps.length === 0) {
      return {
        chain: current,
        modified, iterations,
        counts: baseline.counts,
        totalScore: baseline.totalScore,
        skipped: false,
      };
    }

    iterations = iter + 1;
    const target = worstOffendingLabel(baseline.overlaps);
    if (target === null) break;

    const best = bestCandidateFor(target, current, emitOpts, adapter, names);
    if (best === null) {
      warn(`OwmRenderAdapter degraded while scoring "${target}" — aborting loop`);
      break;
    }
    if (best.totalScore >= baseline.totalScore) break;

    const targetComponent = current.components.find(c => c.name === target);
    if (targetComponent !== undefined && !sameOffset(targetComponent.label, best.offset)) {
      modified.push(target);
      current = withLabel(current, target, best.offset);
    } else {
      break;
    }
  }

  // Phase 5e — local pixel refinement.
  const refinement = refineLocally(current, emitOpts, adapter, names);
  current = refinement.chain;
  for (const name of refinement.refined) {
    if (!modified.includes(name)) modified.push(name);
  }

  // Final probe to capture post-refinement counts.
  const finalProbe = probe(current, emitOpts, adapter, names);
  const counts = finalProbe?.counts ?? lastCounts;
  const totalScore = finalProbe?.totalScore ?? lastScore;
  return { chain: current, modified, iterations, counts, totalScore, skipped: false };
}

// ─── Phase 5f — component nudge fallback ──────────────────────────────

/** Component whose label currently bears the largest hard severity.
 *  Returns null when no hard violation involves a label-bearing
 *  component. */
function pickWorstHardComponent(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  adapter: OwmRenderAdapter,
  names: ReadonlySet<string>,
): string | null {
  const result = probe(chain, emitOpts, adapter, names);
  if (!result) return null;
  const hardScoreByName = new Map<string, number>();
  for (const ov of result.overlaps) {
    if (!HARD_KINDS.has(ov.kind)) continue;
    if (ov.a.kind === 'label') {
      hardScoreByName.set(ov.a.name, (hardScoreByName.get(ov.a.name) ?? 0) + ov.severity);
    }
    if (ov.b.kind === 'label') {
      hardScoreByName.set(ov.b.name, (hardScoreByName.get(ov.b.name) ?? 0) + ov.severity);
    }
  }
  if (hardScoreByName.size === 0) return null;
  let worst: string | null = null;
  let worstScore = -Infinity;
  for (const [name, s] of hardScoreByName) {
    if (s > worstScore) { worst = name; worstScore = s; }
  }
  return worst;
}

/** Apply DSL invariants when nudging `target` to (newX, newY).
 *  Returns true iff every check passes. */
function isValidNudge(
  chain: PositionedValueChain,
  target: PositionedComponent,
  newX: number,
  newY: number,
): boolean {
  // Anchors are immobile by V3 contract.
  if (target.role === 'anchor') return false;

  // Global pixel-space bounds.
  if (newX < NUDGE_X_LOW || newX > NUDGE_X_HIGH) return false;
  if (newY < NUDGE_Y_LOW || newY > NUDGE_Y_HIGH) return false;

  // Stay within the LLM xHint band when the hint is known.
  if (typeof target.xHint === 'number') {
    if (Math.abs(newX - target.xHint) > NUDGE_XHINT_BAND) return false;
  }

  // Strict edge-direction invariant: parents above, children below.
  for (const link of chain.links) {
    if (link.to === target.name) {
      const parent = chain.components.find(c => c.name === link.from);
      if (parent && parent.visibility <= newY + NUDGE_EDGE_GAP_Y) return false;
    }
    if (link.from === target.name) {
      const child = chain.components.find(c => c.name === link.to);
      if (child && newY <= child.visibility + NUDGE_EDGE_GAP_Y) return false;
    }
  }
  return true;
}

/** Generate the four cardinal nudge trial targets for `c`. The
 *  diagonals are deliberately omitted in V1 to keep the trial budget
 *  bounded — most observed cases are resolved by a single cardinal
 *  shift. */
function cardinalNudgesFor(c: PositionedComponent): Array<{ x: number; y: number }> {
  return [
    { x: c.evolution + COMP_NUDGE_X_STEP, y: c.visibility },
    { x: c.evolution - COMP_NUDGE_X_STEP, y: c.visibility },
    { x: c.evolution, y: c.visibility + COMP_NUDGE_Y_STEP },
    { x: c.evolution, y: c.visibility - COMP_NUDGE_Y_STEP },
  ];
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Iteratively correct label offsets and, as a fallback, nudge
 * component positions to minimise the weighted overlap score in the
 * cli-owm render. Returns a new chain with adjusted labels (and
 * possibly adjusted positions) plus a report describing what changed.
 *
 * Pure modulo the ambient degradation collector — accepts the
 * `OwmRenderAdapter` as a parameter rather than fetching it from the
 * registry, so unit tests can inject a deterministic mock.
 */
export function verifyLayout(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  adapter: OwmRenderAdapter,
): VerifyLayoutResult {
  const names = knownNames(chain);
  let result = runLabelLoop(chain, emitOpts, adapter, names);

  if (result.skipped) {
    warn('OwmRenderAdapter unavailable — skipping label verification');
    return {
      chain,
      report: {
        iterations: 0,
        modifiedLabels: [],
        movedComponents: [],
        unresolvedHard:    0,
        unresolvedSpacing: 0,
        unresolvedEdge:    0,
        unresolvedAxis:    0,
        skipped: true,
      },
    };
  }

  const moved: string[] = [];

  // Phase 5f — when label-only optimisation cannot drive hard
  // violations to zero, try cardinal nudges on the worst offending
  // component, re-running the inner label loop after each trial.
  let nudgeIter = 0;
  while (result.counts.hard > 0 && nudgeIter < MAX_COMPONENT_NUDGES) {
    nudgeIter++;
    const target = pickWorstHardComponent(result.chain, emitOpts, adapter, names);
    if (target === null) break;

    const targetComp = result.chain.components.find(c => c.name === target);
    if (!targetComp) break;

    let bestTrial: LabelLoopResult | null = null;
    let bestModified: string[] = [];
    for (const nudge of cardinalNudgesFor(targetComp)) {
      if (!isValidNudge(result.chain, targetComp, nudge.x, nudge.y)) continue;
      const trialChain = withPosition(result.chain, target, nudge.x, nudge.y);
      const trialResult = runLabelLoop(trialChain, emitOpts, adapter, names);
      if (trialResult.skipped) continue;
      if (bestTrial === null || trialResult.totalScore < bestTrial.totalScore) {
        bestTrial = trialResult;
        bestModified = trialResult.modified;
      }
    }

    // Only apply a nudge when it strictly improves the global score.
    if (bestTrial === null || bestTrial.totalScore >= result.totalScore) break;

    moved.push(target);
    // Carry over modifiedLabels from the inner re-run on top of the
    // outer-loop modifications, deduped.
    for (const name of bestModified) {
      if (!result.modified.includes(name)) result.modified.push(name);
    }
    result = bestTrial;
  }

  if (result.counts.hard > 0) {
    warn(
      `verify-layout left ${result.counts.hard} unresolved hard violation(s) after ` +
      `${result.iterations} label iteration(s) and ${nudgeIter} component nudge(s)`,
    );
  }

  return {
    chain: result.chain,
    report: {
      iterations: result.iterations,
      modifiedLabels: result.modified,
      movedComponents: moved,
      unresolvedHard:    result.counts.hard,
      unresolvedSpacing: result.counts.spacing,
      unresolvedEdge:    result.counts.edge,
      unresolvedAxis:    result.counts.axis,
      skipped: false,
    },
  };
}
