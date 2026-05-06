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
import { LABEL_OFFSET_CANDIDATES } from '../../../lib/owm/candidate-offsets.mjs';
import {
  parseSvgGeometry,
  type SvgGeometry,
} from '../../../lib/owm/svg-bbox-parser.mjs';
import {
  detectAllOverlaps,
  type Overlap,
} from '../../../lib/owm/overlap-detector.mjs';
import { getCurrentCollector } from '../../../lib/degradation/index.mjs';

// ─── Constants ──────────────────────────────────────────────────────────

/** Hard cap on the correction loop. Five passes empirically converge
 *  on chains up to ~25 components without runaway oscillation. */
export const MAX_VERIFY_ITERATIONS = 5;

/** Weight applied to each unit of severity for HARD overlap kinds
 *  (label-label, label-component, label-canvas). One unit of HARD
 *  violation outweighs every reasonable count of SOFT crossings. */
export const HARD_PENALTY = 1000;

/** Weight applied to each unit of severity for SOFT overlap kinds
 *  (label-edge). The score is HARD × hard_severity_total +
 *  SOFT × soft_severity_total. */
export const SOFT_PENALTY = 1;

const HARD_KINDS: ReadonlySet<Overlap['kind']> = new Set([
  'label-label',
  'component-label',
  'label-canvas',
]);
const SOFT_KINDS: ReadonlySet<Overlap['kind']> = new Set([
  'label-edge',
]);

// ─── Types ──────────────────────────────────────────────────────────────

export interface VerifyReport {
  /** Render cycles consumed. 0 means the initial layout was already clean. */
  iterations: number;
  /** Names of components whose label offset was moved by the loop. */
  modifiedLabels: string[];
  /** Hard violations remaining at end of loop. 0 is the happy path. */
  unresolvedHard: number;
  /** Soft edge crossings remaining at end of loop. May be > 0 even on
   *  a successful run — the loop minimises this but does not require
   *  it to reach zero. */
  unresolvedSoft: number;
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

interface RenderProbe {
  overlaps: Overlap[];
  geometry: SvgGeometry;
  hardCount: number;
  softCount: number;
  totalScore: number;
}

function summarise(overlaps: readonly Overlap[]): { hardCount: number; softCount: number; totalScore: number } {
  let hardCount = 0;
  let softCount = 0;
  let totalScore = 0;
  for (const ov of overlaps) {
    if (HARD_KINDS.has(ov.kind)) {
      hardCount++;
      totalScore += HARD_PENALTY * ov.severity;
    } else if (SOFT_KINDS.has(ov.kind)) {
      softCount++;
      totalScore += SOFT_PENALTY * ov.severity;
    }
  }
  return { hardCount, softCount, totalScore };
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
  const { hardCount, softCount, totalScore } = summarise(overlaps);
  return { geometry, overlaps, hardCount, softCount, totalScore };
}

/** Pick the label whose label-bearing overlaps weigh the most in the
 *  current score. Returns null when no overlap involves a label
 *  (typical when only out-of-scope component-component pairs remain). */
function worstOffendingLabel(overlaps: readonly Overlap[]): string | null {
  const scoreByName = new Map<string, number>();
  for (const ov of overlaps) {
    const weight = HARD_KINDS.has(ov.kind) ? HARD_PENALTY
                 : SOFT_KINDS.has(ov.kind) ? SOFT_PENALTY
                 : 0;
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
  for (const candidate of LABEL_OFFSET_CANDIDATES) {
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

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Iteratively correct label offsets to minimise the weighted overlap
 * score (hard violations first, then soft edge crossings) in the
 * cli-owm render. Returns a new chain with adjusted labels and a
 * report describing what happened.
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
  const modified: string[] = [];
  let current = chain;
  let lastHard = 0;
  let lastSoft = 0;
  let iterations = 0;

  for (let iter = 0; iter < MAX_VERIFY_ITERATIONS; iter++) {
    const baseline = probe(current, emitOpts, adapter, names);
    if (baseline === null) {
      warn('OwmRenderAdapter unavailable — skipping label verification');
      return {
        chain,
        report: {
          iterations,
          modifiedLabels: modified,
          unresolvedHard: 0,
          unresolvedSoft: 0,
          skipped: true,
        },
      };
    }
    lastHard = baseline.hardCount;
    lastSoft = baseline.softCount;

    if (baseline.overlaps.length === 0) {
      return {
        chain: current,
        report: {
          iterations,
          modifiedLabels: modified,
          unresolvedHard: 0,
          unresolvedSoft: 0,
          skipped: false,
        },
      };
    }

    iterations = iter + 1;
    const target = worstOffendingLabel(baseline.overlaps);
    if (target === null) {
      // Only component-component or anchor-* overlaps left — out of
      // scope for label correction.
      break;
    }

    const best = bestCandidateFor(target, current, emitOpts, adapter, names);
    if (best === null) {
      // Every candidate evaluation degraded → adapter is flaky mid-loop.
      warn(`OwmRenderAdapter degraded while scoring "${target}" — aborting loop`);
      break;
    }

    if (best.totalScore >= baseline.totalScore) {
      // No candidate strictly improved (all-eight tied or worse).
      break;
    }

    const targetComponent = current.components.find(c => c.name === target);
    if (targetComponent !== undefined && !sameOffset(targetComponent.label, best.offset)) {
      modified.push(target);
      current = withLabel(current, target, best.offset);
    } else {
      // The "best" candidate is what we already have — bail to avoid
      // looping on a fixed point.
      break;
    }
  }

  // Final probe to report the residual breakdown after the loop.
  const finalProbe = probe(current, emitOpts, adapter, names);
  const unresolvedHard = finalProbe?.hardCount ?? lastHard;
  const unresolvedSoft = finalProbe?.softCount ?? lastSoft;
  if (unresolvedHard > 0) {
    warn(`verify-layout left ${unresolvedHard} unresolved hard violation(s) after ${iterations} iteration(s)`);
  }

  return {
    chain: current,
    report: {
      iterations,
      modifiedLabels: modified,
      unresolvedHard,
      unresolvedSoft,
      skipped: false,
    },
  };
}
