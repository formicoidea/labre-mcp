// Step 7 of the write:chain:* pipeline — collision-aware label
// correction loop, V6 (full force-directed on analytical geometry).
//
// V6 replaces the V5 greedy-discrete + refinement + nudge stack with
// a continuous physics-based simulation. The pipeline now reads as:
//
//   1. simulateLabels             — physics on label particles
//   2. if hard residuals remain:
//      simulateComponents         — nudge component circles within
//                                    DSL invariant bands
//      simulateLabels (re-run)    — re-settle labels around new
//                                    component positions
//   3. projectHardConstraints     — deterministic clamp guaranteeing
//                                    unresolvedHard = 0 at output
//
// Public API surface preserved across V5 → V6:
//   - `verifyLayout(chain, emitOpts, adapter)` signature unchanged.
//   - `OwmRenderAdapter` is still accepted but NOT invoked during
//     placement. Geometry comes from `computeGeometry` (Phase 6a).
//   - `VerifyReport` shape unchanged (modifiedLabels, movedComponents,
//     unresolvedHard / Spacing / Edge / Axis, skipped).
//
// Performance: cli-owm is no longer in the hot path. End-to-end
// latency drops from V5's ~14 s worst case to < 100 ms typical.

import type {
  PositionedValueChain,
} from '../../../types/value-chain.mjs';
import type { EmitOwmOptions } from './emit-owm.mjs';
import type { OwmRenderAdapter } from '../../../lib/owm/render-adapter.mjs';
import {
  detectAllOverlaps,
  type Overlap,
} from '../../../lib/owm/overlap-detector.mjs';
import { computeGeometry } from '../../../lib/owm/analytical-geometry.mjs';
import {
  simulateLabels,
  simulateComponents,
  projectHardConstraints,
} from './force-directed.mjs';
import { getCurrentCollector } from '../../../lib/degradation/index.mjs';

// ─── Types ──────────────────────────────────────────────────────────────

export interface VerifyReport {
  /** Force-directed iterations consumed by the label simulation. */
  iterations: number;
  /** Names of components whose label offset moved during the pipeline. */
  modifiedLabels: string[];
  /** Names of components whose position was nudged by Phase 6c. */
  movedComponents: string[];
  /** Hard violations remaining at end of loop. With Phase 6d in place
   *  this should always be 0 — non-zero indicates a corner case the
   *  projection couldn't resolve. */
  unresolvedHard: number;
  /** Soft label-spacing violations remaining (gap < 24 px). */
  unresolvedSpacing: number;
  /** Soft label-edge crossings remaining. */
  unresolvedEdge: number;
  /** Soft label-axis straddlings remaining. */
  unresolvedAxis: number;
  /** Reserved for future failures (e.g. analytical geometry crash).
   *  Always `false` in V6 since we no longer depend on cli-owm. */
  skipped: boolean;
}

export interface VerifyLayoutResult {
  chain: PositionedValueChain;
  report: VerifyReport;
}

// ─── Helpers ────────────────────────────────────────────────────────────

const HARD_KINDS: ReadonlySet<Overlap['kind']> = new Set([
  'label-label',
  'component-label',
  'label-canvas',
]);

interface BreakdownCounts {
  hard: number;
  spacing: number;
  edge: number;
  axis: number;
}

function summarise(overlaps: readonly Overlap[]): BreakdownCounts {
  const counts: BreakdownCounts = { hard: 0, spacing: 0, edge: 0, axis: 0 };
  for (const ov of overlaps) {
    if (HARD_KINDS.has(ov.kind))            counts.hard++;
    else if (ov.kind === 'label-spacing')   counts.spacing++;
    else if (ov.kind === 'label-edge')      counts.edge++;
    else if (ov.kind === 'label-axis')      counts.axis++;
  }
  return counts;
}

function warn(message: string): void {
  const collector = getCurrentCollector();
  if (collector) {
    collector.recordError('write-chain:verify-layout', new Error(message), {
      recoverable: true,
      severity: 'warning',
    });
  }
}

function mergeUnique(target: string[], additions: readonly string[]): void {
  for (const name of additions) {
    if (!target.includes(name)) target.push(name);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * V6 — three-stage force-directed placement plus a deterministic
 * projection. The `adapter` parameter is kept on the public API for
 * backward compatibility but is no longer invoked during placement;
 * geometry is computed analytically from the chain.
 */
export function verifyLayout(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  // any: signature compat with V5 callers — adapter unused in V6
  _adapter: OwmRenderAdapter,
): VerifyLayoutResult {
  const modifiedLabels: string[] = [];
  const movedComponents: string[] = [];

  // Stage 1 — force-directed label simulation.
  const labelSim = simulateLabels(chain, emitOpts);
  let current = labelSim.chain;
  let iterations = labelSim.iterations;
  mergeUnique(modifiedLabels, labelSim.modified);

  // Check for hard residuals after the label sim.
  let geometry = computeGeometry(current, emitOpts);
  let overlaps = detectAllOverlaps(geometry);
  let counts = summarise(overlaps);

  // Stage 2 — when hard violations persist, nudge components and
  // re-run the label sim around the new component positions.
  if (counts.hard > 0) {
    const compSim = simulateComponents(current, emitOpts);
    current = compSim.chain;
    mergeUnique(movedComponents, compSim.moved);

    const labelSim2 = simulateLabels(current, emitOpts);
    current = labelSim2.chain;
    iterations += labelSim2.iterations;
    mergeUnique(modifiedLabels, labelSim2.modified);
  }

  // Stage 3 — strict projection. Guarantees unresolvedHard = 0
  // (modulo unresolvable corner cases which are surfaced in the report).
  current = projectHardConstraints(current, emitOpts);

  // Final report.
  geometry = computeGeometry(current, emitOpts);
  overlaps = detectAllOverlaps(geometry);
  counts = summarise(overlaps);

  if (counts.hard > 0) {
    warn(
      `verify-layout left ${counts.hard} unresolved hard violation(s) ` +
      `after force-directed simulation and strict projection`,
    );
  }

  return {
    chain: current,
    report: {
      iterations,
      modifiedLabels,
      movedComponents,
      unresolvedHard:    counts.hard,
      unresolvedSpacing: counts.spacing,
      unresolvedEdge:    counts.edge,
      unresolvedAxis:    counts.axis,
      skipped: false,
    },
  };
}
