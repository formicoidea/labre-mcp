// Phase 6b — force-directed simulation for label placement.
//
// Each label is a particle subject to:
//   - attraction toward its "home" position (seed from place-labels)
//   - repulsion from every other rendered element except its own
//     component (other labels, foreign component circles, foreign
//     anchor texts, foreign edge segments, phase-axis lines)
//   - inward force when the label bbox extends past the visible map
//
// Integration is explicit Euler with damping. Convergence is detected
// via total kinetic energy or hard iteration cap. The simulation is
// pure JS — geometry is recomputed analytically each step
// (`computeGeometry`), no cli-owm calls.
//
// All distances are pixel-space inside the cli-owm canvas.

import type {
  PositionedValueChain,
  PositionedComponent,
} from '#types/value-chain.mjs';
import type { EmitOwmOptions } from '../emit/emit-owm.mjs';
import {
  LABEL_CHAR_WIDTH,
  LABEL_HEIGHT,
  COMPONENT_RADIUS,
  type Bbox,
  type EdgeSegment,
  type SvgGeometry,
} from '#lib/owm/svg-bbox-parser.mjs';
import {
  computeGeometry,
  DEFAULT_MAP_WIDTH,
  DEFAULT_MAP_HEIGHT,
} from '#lib/owm/analytical-geometry.mjs';
import {
  detectAllOverlaps,
  type Overlap,
} from '#lib/owm/overlap-detector.mjs';

// ─── Constants ──────────────────────────────────────────────────────────

/** Velocity decay per iteration. Higher = slower convergence but
 *  more oscillation-resistant. */
export const DAMPING = 0.85;
/** Spring constant pulling each label back to its seed position. */
export const HOME_ATTRACTION = 0.5;
/** Repulsion between two label rectangles (point-to-point form). */
export const LABEL_REPULSION = 1000;
/** Repulsion between a label and a foreign component circle. */
export const COMPONENT_REPULSION = 800;
/** Repulsion between a label and a foreign anchor text. */
export const ANCHOR_REPULSION = 800;
/** Repulsion between a label and a third-party edge segment
 *  (perpendicular distance to the segment). Smaller than label/label
 *  because edges are 1D and the visual penalty is lower. */
export const EDGE_REPULSION = 400;
/** Soft horizontal repulsion away from a phase-axis vertical line.
 *  Lowest priority. */
export const AXIS_REPULSION = 50;
/** Linear restoring force applied when the label bbox crosses the
 *  visible map boundary. */
export const BOUNDARY_REPULSION = 5;
/** Distance floor used in 1/d² formulas to avoid singularities. */
export const EPSILON = 1.0;
/** Hard cap on the simulation; converged systems usually finish in
 *  10–25 iterations. */
export const SIM_LABEL_ITERATIONS = 50;
/** When the total kinetic energy drops below this, the system is in
 *  equilibrium and we stop early. */
export const KINETIC_ENERGY_THRESHOLD = 1e-3;
/** Hard cap on velocity magnitude per axis. Prevents the simulation
 *  from diverging when given pathological starting positions (e.g.
 *  a label initialised far outside the canvas). Without this cap,
 *  the boundary repulsion can amplify to chaotic levels. */
export const MAX_VELOCITY = 50;

// ─── Phase 6c constants — component fallback ───────────────────────────

/** Iteration cap for the component-nudge fallback. Components should
 *  barely move so we keep this lower than the label cap. */
export const SIM_COMPONENT_ITERATIONS = 30;
/** Stronger spring than for labels — components are upstream-decided
 *  positions, we want them to drift only when no other option works. */
export const COMPONENT_HOME_ATTRACTION = 2.0;
/** Tolerance band around the LLM-proposed `xHint`. Mirrors
 *  `BAND_HALF` from adjust-x. */
const NORM_BAND_HALF = 0.10;
/** Strict gap (in normalised Y units) preserved between a parent and
 *  a child after clamping. Mirrors `EDGE_MIN_GAP` from
 *  compute-visibility. */
const NORM_EDGE_GAP_Y = 0.01;
/** Global X / Y bounds (normalised) — match the canvas envelope used
 *  by compute-visibility and adjust-x. */
const NORM_LEFT_BOUND  = 0.10;
const NORM_RIGHT_BOUND = 0.90;
const NORM_Y_MIN       = 0.10;
const NORM_Y_MAX       = 0.95;
/** Maximum number of clamp passes per iteration when resolving link
 *  Y-direction conflicts on a chain. Five is enough for typical
 *  Wardley DAGs. */
const CLAMP_PASSES = 5;

// ─── Phase 6d constants — strict projection ───────────────────────────

/** Maximum number of detect → push rounds during the projection
 *  post-pass. Bumped from 5 → 10 after a smoke test on a 14-component
 *  Spotify chain showed 2 residual hard violations remaining when the
 *  cascade required ≥ 6 passes to settle. */
export const PROJECTION_ITERATIONS = 10;

/** Extra clearance (px) added to every separation push so the result
 *  survives the integer rounding at emit. Separating two rects to
 *  *exactly touching* leaves a sub-pixel gap that `Math.round` collapses
 *  back into an overlap — the classic failure for two long labels that
 *  overlap by a thin band (e.g. 0.5 px tall × 78 px wide = 39 px² of
 *  "hard" overlap the float pass clears but rounding reintroduces). One
 *  full pixel of clearance guarantees the rounded labels stay apart. */
export const PROJECTION_SEPARATION_MARGIN_PX = 2;

// ─── Particle ──────────────────────────────────────────────────────────

interface LabelParticle {
  componentName: string;
  /** Anchor circle centre — never moves during the simulation. */
  cx: number;
  cy: number;
  /** Seed position from place-labels — the spring rest point. */
  homeX: number;
  homeY: number;
  /** Live simulated position (= label text origin in SVG terms). */
  px: number;
  py: number;
  /** Current velocity. */
  vx: number;
  vy: number;
  /** Cached label bbox dimensions (constant during sim). */
  width: number;
  height: number;
}

// ─── Geometry helpers ──────────────────────────────────────────────────

/** Distance from a 2D point to the closest point on a segment. */
function pointSegmentDistance(
  px: number, py: number,
  seg: EdgeSegment,
): { closestX: number; closestY: number; distance: number } {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq));
  const closestX = seg.x1 + t * dx;
  const closestY = seg.y1 + t * dy;
  const ex = px - closestX;
  const ey = py - closestY;
  return { closestX, closestY, distance: Math.sqrt(ex * ex + ey * ey) };
}

function bboxCenter(b: Bbox): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// ─── Public API ────────────────────────────────────────────────────────

export interface SimulateLabelsResult {
  chain: PositionedValueChain;
  iterations: number;
  modified: string[];
  /** Final kinetic energy at termination — useful for diagnostics. */
  finalKineticEnergy: number;
}

/**
 * Run the force-directed label simulation on `chain`. Returns a new
 * chain with updated `LabelOffset` values (rounded to integers) plus
 * iteration / energy diagnostics. Does NOT mutate the input.
 */
export function simulateLabels(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  options?: { iterations?: number },
): SimulateLabelsResult {
  const maxIter = options?.iterations ?? SIM_LABEL_ITERATIONS;
  const geometry = computeGeometry(chain, emitOpts);

  const mapWidth  = emitOpts.size?.width  ?? DEFAULT_MAP_WIDTH;
  const mapHeight = emitOpts.size?.height ?? DEFAULT_MAP_HEIGHT;

  // Index immutable repulsion sources.
  const foreignCircles = new Map<string, { x: number; y: number }>();
  const foreignAnchors = new Map<string, { x: number; y: number }>();
  for (const item of geometry.items) {
    if (item.kind === 'component') {
      const c = bboxCenter(item.bbox);
      foreignCircles.set(item.name, { x: c.x, y: c.y });
    } else if (item.kind === 'anchor') {
      const c = bboxCenter(item.bbox);
      foreignAnchors.set(item.name, { x: c.x, y: c.y });
    }
  }

  // Build particle list from non-anchor components only.
  const particles: LabelParticle[] = [];
  for (const c of chain.components) {
    if (c.role === 'anchor') continue;
    const cx = c.evolution * mapWidth;
    const cy = (1 - c.visibility) * mapHeight;
    const dx = c.label.dx;
    const dy = c.label.dy;
    const width = Math.max(1, c.name.length) * LABEL_CHAR_WIDTH;
    particles.push({
      componentName: c.name,
      cx, cy,
      homeX: cx + dx, homeY: cy + dy,
      px:    cx + dx, py:    cy + dy,
      vx: 0, vy: 0,
      width, height: LABEL_HEIGHT,
    });
  }

  let finalKineticEnergy = 0;
  let iterations = 0;
  const epsSq = EPSILON * EPSILON;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;

    // Compute forces for every particle into a fresh array so the
    // updates within an iteration use a consistent snapshot.
    const forces: { fx: number; fy: number }[] = particles.map(() => ({ fx: 0, fy: 0 }));

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const f = forces[i];

      // Home attraction.
      f.fx += HOME_ATTRACTION * (p.homeX - p.px);
      f.fy += HOME_ATTRACTION * (p.homeY - p.py);

      // Repulsion from other labels.
      for (let j = 0; j < particles.length; j++) {
        if (i === j) continue;
        const q = particles[j];
        const dx = p.px - q.px;
        const dy = p.py - q.py;
        const d2 = Math.max(dx * dx + dy * dy, epsSq);
        const d  = Math.sqrt(d2);
        const mag = LABEL_REPULSION / d2;
        f.fx += mag * dx / d;
        f.fy += mag * dy / d;
      }

      // Repulsion from foreign component circles (skip own).
      for (const [name, c] of foreignCircles) {
        if (name === p.componentName) continue;
        const dx = p.px - c.x;
        const dy = p.py - c.y;
        const d2 = Math.max(dx * dx + dy * dy, epsSq);
        const d  = Math.sqrt(d2);
        const mag = COMPONENT_REPULSION / d2;
        f.fx += mag * dx / d;
        f.fy += mag * dy / d;
      }

      // Repulsion from foreign anchor texts.
      for (const [, a] of foreignAnchors) {
        const dx = p.px - a.x;
        const dy = p.py - a.y;
        const d2 = Math.max(dx * dx + dy * dy, epsSq);
        const d  = Math.sqrt(d2);
        const mag = ANCHOR_REPULSION / d2;
        f.fx += mag * dx / d;
        f.fy += mag * dy / d;
      }

      // Repulsion from edges (skip those incident to this component).
      for (const edge of geometry.edges) {
        if (edge.from === p.componentName || edge.to === p.componentName) continue;
        const { closestX, closestY, distance } = pointSegmentDistance(p.px, p.py, edge);
        const d  = Math.max(distance, EPSILON);
        const dx = p.px - closestX;
        const dy = p.py - closestY;
        const mag = EDGE_REPULSION / (d * d);
        f.fx += mag * dx / d;
        f.fy += mag * dy / d;
      }

      // Repulsion from phase-axis vertical lines (X-axis only).
      for (const axisX of geometry.phaseAxes) {
        const dx = p.px - axisX;
        const d  = Math.max(Math.abs(dx), EPSILON);
        const mag = AXIS_REPULSION / (d * d);
        f.fx += mag * Math.sign(dx);
      }

      // Boundary inward force when the label bbox crosses the visible
      // map area. Linear restoring force (proportional to overshoot).
      const left   = p.px;
      const right  = p.px + p.width;
      const top    = p.py - (LABEL_HEIGHT - 2);
      const bottom = top + p.height;
      if (left   < geometry.mapArea.x)                            f.fx += BOUNDARY_REPULSION * (geometry.mapArea.x - left);
      if (right  > geometry.mapArea.x + geometry.mapArea.width)   f.fx -= BOUNDARY_REPULSION * (right  - (geometry.mapArea.x + geometry.mapArea.width));
      if (top    < geometry.mapArea.y)                            f.fy += BOUNDARY_REPULSION * (geometry.mapArea.y - top);
      if (bottom > geometry.mapArea.y + geometry.mapArea.height)  f.fy -= BOUNDARY_REPULSION * (bottom - (geometry.mapArea.y + geometry.mapArea.height));
    }

    // Integrate. Damped Euler with per-axis velocity cap to keep the
    // simulation stable under pathological starting positions.
    let totalKE = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const f = forces[i];
      let nvx = DAMPING * (p.vx + f.fx);
      let nvy = DAMPING * (p.vy + f.fy);
      if (nvx >  MAX_VELOCITY) nvx =  MAX_VELOCITY;
      if (nvx < -MAX_VELOCITY) nvx = -MAX_VELOCITY;
      if (nvy >  MAX_VELOCITY) nvy =  MAX_VELOCITY;
      if (nvy < -MAX_VELOCITY) nvy = -MAX_VELOCITY;
      p.vx = nvx;
      p.vy = nvy;
      p.px += p.vx;
      p.py += p.vy;
      totalKE += 0.5 * (p.vx * p.vx + p.vy * p.vy);
    }
    finalKineticEnergy = totalKE;

    if (totalKE < KINETIC_ENERGY_THRESHOLD) break;
  }

  // Project particle positions back onto LabelOffsets, rounded to
  // integers (the OWM DSL takes integer offsets).
  const particlesByName = new Map(particles.map(p => [p.componentName, p]));
  const modified: string[] = [];
  const updatedComponents: PositionedComponent[] = chain.components.map(c => {
    if (c.role === 'anchor') return c;
    const p = particlesByName.get(c.name);
    if (!p) return c;
    const newDx = Math.round(p.px - p.cx);
    const newDy = Math.round(p.py - p.cy);
    if (newDx !== c.label.dx || newDy !== c.label.dy) {
      modified.push(c.name);
    }
    return { ...c, label: { dx: newDx, dy: newDy } };
  });

  return {
    chain: {
      metadata: chain.metadata,
      links: chain.links,
      components: updatedComponents,
    },
    iterations,
    modified,
    finalKineticEnergy,
  };
}

// ─── Phase 6c — Force-directed component fallback ─────────────────────

interface ComponentParticle {
  name: string;
  /** Home position in pixel space — the (cx, cy) before this fallback. */
  homeX: number;
  homeY: number;
  /** Live simulated position. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  /** Optional LLM-proposed X (normalised) for the tolerance band clamp. */
  xHint: number | undefined;
  role: 'need' | 'capability';
}

export interface SimulateComponentsResult {
  chain: PositionedValueChain;
  iterations: number;
  /** Names of non-anchor components whose (X, Y) actually moved. */
  moved: string[];
  finalKineticEnergy: number;
}

/** Apply the DSL-invariant clamps to a single particle in normalised
 *  space. Modifies the particle in place. Returns true iff the
 *  particle's position changed. */
function clampDslInvariants(
  p: ComponentParticle,
  parentsByChild: ReadonlyMap<string, string[]>,
  childrenByParent: ReadonlyMap<string, string[]>,
  particleByName: ReadonlyMap<string, ComponentParticle>,
  mapWidth: number,
  mapHeight: number,
): boolean {
  let normX = p.px / mapWidth;
  let normY = 1 - p.py / mapHeight;

  // Global bounds
  if (normX < NORM_LEFT_BOUND)  normX = NORM_LEFT_BOUND;
  if (normX > NORM_RIGHT_BOUND) normX = NORM_RIGHT_BOUND;
  if (normY < NORM_Y_MIN)       normY = NORM_Y_MIN;
  if (normY > NORM_Y_MAX)       normY = NORM_Y_MAX;

  // xHint band when the LLM hint is known
  if (typeof p.xHint === 'number') {
    if (normX < p.xHint - NORM_BAND_HALF) normX = p.xHint - NORM_BAND_HALF;
    if (normX > p.xHint + NORM_BAND_HALF) normX = p.xHint + NORM_BAND_HALF;
    // Re-clamp to global bounds in case xHint was near an edge.
    if (normX < NORM_LEFT_BOUND)  normX = NORM_LEFT_BOUND;
    if (normX > NORM_RIGHT_BOUND) normX = NORM_RIGHT_BOUND;
  }

  // Strict edge-direction: parent above child
  for (const parentName of parentsByChild.get(p.name) ?? []) {
    const parent = particleByName.get(parentName);
    const parentY = parent
      ? 1 - parent.py / mapHeight
      // Anchors are stored separately — fall back to the chain.
      : null;
    if (parentY !== null && normY > parentY - NORM_EDGE_GAP_Y) {
      normY = parentY - NORM_EDGE_GAP_Y;
    }
  }
  for (const childName of childrenByParent.get(p.name) ?? []) {
    const child = particleByName.get(childName);
    const childY = child ? 1 - child.py / mapHeight : null;
    if (childY !== null && normY < childY + NORM_EDGE_GAP_Y) {
      normY = childY + NORM_EDGE_GAP_Y;
    }
  }
  // Re-clamp Y after link adjustments.
  if (normY < NORM_Y_MIN) normY = NORM_Y_MIN;
  if (normY > NORM_Y_MAX) normY = NORM_Y_MAX;

  const newPx = normX * mapWidth;
  const newPy = (1 - normY) * mapHeight;
  const moved = newPx !== p.px || newPy !== p.py;
  if (moved) {
    // Zero out velocity along axes that hit a clamp so the particle
    // doesn't immediately bounce out again.
    if (newPx !== p.px) p.vx = 0;
    if (newPy !== p.py) p.vy = 0;
    p.px = newPx;
    p.py = newPy;
  }
  return moved;
}

/**
 * Phase 6c — force-directed simulation on non-anchor components.
 * Same physics model as `simulateLabels` but applied to component
 * circles, with DSL-invariant clamps after every integration step:
 *  - anchors immobile (excluded from the particle set)
 *  - X kept inside [LEFT_BOUND, RIGHT_BOUND] and `xHint ± BAND_HALF`
 *  - Y kept inside [Y_MIN, ANCHOR_VISIBILITY]
 *  - For every link `(parent, child)`: Y(parent) > Y(child) + EDGE_GAP_Y
 *
 * Labels are NOT re-simulated here — they ride along with their
 * component (rigid attachment via the unchanged `LabelOffset`). The
 * caller (`verify-layout`) is expected to re-run `simulateLabels`
 * afterwards to settle labels around the new component positions.
 */
export function simulateComponents(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  options?: { iterations?: number },
): SimulateComponentsResult {
  const maxIter = options?.iterations ?? SIM_COMPONENT_ITERATIONS;
  const mapWidth  = emitOpts.size?.width  ?? DEFAULT_MAP_WIDTH;
  const mapHeight = emitOpts.size?.height ?? DEFAULT_MAP_HEIGHT;
  const epsSq = EPSILON * EPSILON;

  // Index the immutable repulsion sources (anchors + labels).
  const anchorPositions = new Map<string, { x: number; y: number }>();
  const labelPositions  = new Map<string, { x: number; y: number }>();
  for (const c of chain.components) {
    const cx = c.evolution * mapWidth;
    const cy = (1 - c.visibility) * mapHeight;
    if (c.role === 'anchor') {
      anchorPositions.set(c.name, { x: cx, y: cy });
    } else {
      // Approximate the label centre.
      const labelW = Math.max(1, c.name.length) * LABEL_CHAR_WIDTH;
      labelPositions.set(c.name, {
        x: cx + c.label.dx + labelW / 2,
        y: cy + c.label.dy + 1, // text baseline is roughly mid-height
      });
    }
  }

  // Particle list (non-anchor only).
  const particles: ComponentParticle[] = [];
  for (const c of chain.components) {
    if (c.role === 'anchor') continue;
    const cx = c.evolution * mapWidth;
    const cy = (1 - c.visibility) * mapHeight;
    particles.push({
      name: c.name,
      homeX: cx, homeY: cy,
      px: cx,    py: cy,
      vx: 0,     vy: 0,
      xHint: c.xHint,
      role: c.role,
    });
  }

  // Index parents / children for clamping.
  const parentsByChild  = new Map<string, string[]>();
  const childrenByParent = new Map<string, string[]>();
  for (const link of chain.links) {
    if (!parentsByChild.has(link.to))    parentsByChild.set(link.to, []);
    if (!childrenByParent.has(link.from)) childrenByParent.set(link.from, []);
    parentsByChild.get(link.to)!.push(link.from);
    childrenByParent.get(link.from)!.push(link.to);
  }

  const particleByName = new Map(particles.map(p => [p.name, p]));

  // Edge geometry (recomputed each iteration since components move).
  const componentByName = new Map(chain.components.map(c => [c.name, c]));

  let finalKineticEnergy = 0;
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;

    // Build live edge segments from current particle / anchor positions.
    const edges: EdgeSegment[] = [];
    for (const link of chain.links) {
      const fromP = particleByName.get(link.from);
      const toP   = particleByName.get(link.to);
      const fromA = anchorPositions.get(link.from);
      const toA   = anchorPositions.get(link.to);
      const x1 = fromP ? fromP.px : fromA?.x;
      const y1 = fromP ? fromP.py : fromA?.y;
      const x2 = toP   ? toP.px   : toA?.x;
      const y2 = toP   ? toP.py   : toA?.y;
      if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
      edges.push({ from: link.from, to: link.to, x1, y1, x2, y2 });
    }

    const forces: { fx: number; fy: number }[] = particles.map(() => ({ fx: 0, fy: 0 }));

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const f = forces[i];

      // Home attraction (strong).
      f.fx += COMPONENT_HOME_ATTRACTION * (p.homeX - p.px);
      f.fy += COMPONENT_HOME_ATTRACTION * (p.homeY - p.py);

      // Repulsion from other component particles.
      for (let j = 0; j < particles.length; j++) {
        if (i === j) continue;
        const q = particles[j];
        const dx = p.px - q.px;
        const dy = p.py - q.py;
        const d2 = Math.max(dx * dx + dy * dy, epsSq);
        const d  = Math.sqrt(d2);
        const mag = LABEL_REPULSION / d2;
        f.fx += mag * dx / d;
        f.fy += mag * dy / d;
      }

      // Repulsion from foreign labels (the label sim already settled them).
      for (const [name, l] of labelPositions) {
        if (name === p.name) continue;
        const dx = p.px - l.x;
        const dy = p.py - l.y;
        const d2 = Math.max(dx * dx + dy * dy, epsSq);
        const d  = Math.sqrt(d2);
        const mag = COMPONENT_REPULSION / d2;
        f.fx += mag * dx / d;
        f.fy += mag * dy / d;
      }

      // Repulsion from anchors.
      for (const [, a] of anchorPositions) {
        const dx = p.px - a.x;
        const dy = p.py - a.y;
        const d2 = Math.max(dx * dx + dy * dy, epsSq);
        const d  = Math.sqrt(d2);
        const mag = ANCHOR_REPULSION / d2;
        f.fx += mag * dx / d;
        f.fy += mag * dy / d;
      }

      // Repulsion from foreign edges (own-incident edges skipped).
      for (const edge of edges) {
        if (edge.from === p.name || edge.to === p.name) continue;
        const { closestX, closestY, distance } = pointSegmentDistance(p.px, p.py, edge);
        const d  = Math.max(distance, EPSILON);
        const dx = p.px - closestX;
        const dy = p.py - closestY;
        const mag = EDGE_REPULSION / (d * d);
        f.fx += mag * dx / d;
        f.fy += mag * dy / d;
      }
    }

    // Integrate.
    let totalKE = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const fr = forces[i];
      let nvx = DAMPING * (p.vx + fr.fx);
      let nvy = DAMPING * (p.vy + fr.fy);
      if (nvx >  MAX_VELOCITY) nvx =  MAX_VELOCITY;
      if (nvx < -MAX_VELOCITY) nvx = -MAX_VELOCITY;
      if (nvy >  MAX_VELOCITY) nvy =  MAX_VELOCITY;
      if (nvy < -MAX_VELOCITY) nvy = -MAX_VELOCITY;
      p.vx = nvx;
      p.vy = nvy;
      p.px += p.vx;
      p.py += p.vy;
      totalKE += 0.5 * (p.vx * p.vx + p.vy * p.vy);
    }
    finalKineticEnergy = totalKE;

    // Apply DSL-invariant clamps repeatedly until stable. Process
    // particles in topological order (parents first) using the
    // chain.components ordering as a pragmatic approximation of depth.
    for (let pass = 0; pass < CLAMP_PASSES; pass++) {
      let anyChanged = false;
      for (const p of particles) {
        if (clampDslInvariants(p, parentsByChild, childrenByParent, particleByName, mapWidth, mapHeight)) {
          anyChanged = true;
        }
      }
      if (!anyChanged) break;
    }

    if (totalKE < KINETIC_ENERGY_THRESHOLD) break;
  }

  // Build updated chain.
  const moved: string[] = [];
  const updatedComponents: PositionedComponent[] = chain.components.map(c => {
    if (c.role === 'anchor') return c;
    const p = particleByName.get(c.name);
    if (!p) return c;
    const newX = Math.max(NORM_LEFT_BOUND, Math.min(NORM_RIGHT_BOUND, p.px / mapWidth));
    const newY = Math.max(NORM_Y_MIN,      Math.min(NORM_Y_MAX,       1 - p.py / mapHeight));
    // Round to 4 decimal places to keep the DSL output stable.
    const roundedX = Math.round(newX * 10000) / 10000;
    const roundedY = Math.round(newY * 10000) / 10000;
    if (roundedX !== c.evolution || roundedY !== c.visibility) {
      moved.push(c.name);
    }
    return { ...c, evolution: roundedX, visibility: roundedY };
  });

  return {
    chain: {
      metadata: chain.metadata,
      links: chain.links,
      components: updatedComponents,
    },
    iterations,
    moved,
    finalKineticEnergy,
  };
}

// ─── Phase 6d — Strict projection post-pass ───────────────────────────

const HARD_KINDS_FOR_PROJECTION: ReadonlySet<Overlap['kind']> = new Set([
  'label-label',
  'component-label',
  'label-canvas',
]);

/** Minimum push (delta vector) to separate two axis-aligned rectangles.
 *  Picks the axis with smaller overlap (cheaper resolution). Returns
 *  the push to apply to `a` away from `b` (caller distributes between
 *  the two as needed). */
function computeMinSeparation(a: Bbox, b: Bbox): { dx: number; dy: number } {
  const aRight  = a.x + a.width;
  const aBottom = a.y + a.height;
  const bRight  = b.x + b.width;
  const bBottom = b.y + b.height;
  const overlapX = Math.min(aRight, bRight) - Math.max(a.x, b.x);
  const overlapY = Math.min(aBottom, bBottom) - Math.max(a.y, b.y);
  if (overlapX <= 0 || overlapY <= 0) return { dx: 0, dy: 0 };

  // Add a round-safe clearance so the separation survives the integer
  // rounding at emit — separating to exactly touching leaves a sub-pixel
  // gap that Math.round collapses back into an overlap.
  const m = PROJECTION_SEPARATION_MARGIN_PX;
  if (overlapX < overlapY) {
    // Cheaper to resolve along X.
    const aCenterX = a.x + a.width / 2;
    const bCenterX = b.x + b.width / 2;
    const sign = aCenterX < bCenterX ? -1 : 1;
    return { dx: sign * (overlapX + m), dy: 0 };
  }
  const aCenterY = a.y + a.height / 2;
  const bCenterY = b.y + b.height / 2;
  const sign = aCenterY < bCenterY ? -1 : 1;
  return { dx: 0, dy: sign * (overlapY + m) };
}

/**
 * Phase 6d — deterministic post-pass that pushes labels apart, away
 * from foreign component circles, and back inside the canvas until
 * no hard violation remains (`unresolvedHard = 0`) or
 * `PROJECTION_ITERATIONS` is reached.
 *
 * Operates on label offsets only — component circle positions are
 * frozen at this stage (Phase 6c handled those, if needed).
 *
 * Internal state is kept in floating-point to avoid the rounding
 * pitfall: a sub-pixel push (e.g. 0.4 px) rounds to 0 and the
 * iteration makes no progress. We integrate continuously and round
 * only at the final emission. The input chain is not mutated.
 */
export function projectHardConstraints(
  chain: PositionedValueChain,
  emitOpts: EmitOwmOptions,
  options?: { iterations?: number },
): PositionedValueChain {
  const maxIter = options?.iterations ?? PROJECTION_ITERATIONS;

  // Internal float labels by component name.
  const floatLabels = new Map<string, { dx: number; dy: number }>();
  for (const c of chain.components) {
    if (c.role === 'anchor') continue;
    floatLabels.set(c.name, { dx: c.label.dx, dy: c.label.dy });
  }

  // Build a snapshot chain with the current float labels for
  // geometry computation. Anchors pass through unchanged.
  function snapshotChain(): PositionedValueChain {
    return {
      metadata: chain.metadata,
      links: chain.links,
      components: chain.components.map(c => {
        if (c.role === 'anchor') return c;
        const lbl = floatLabels.get(c.name);
        if (!lbl) return c;
        return { ...c, label: { dx: lbl.dx, dy: lbl.dy } };
      }),
    };
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const geometry = computeGeometry(snapshotChain(), emitOpts);
    const overlaps = detectAllOverlaps(geometry);
    const hard = overlaps.filter(o => HARD_KINDS_FOR_PROJECTION.has(o.kind));
    if (hard.length === 0) break;

    const pushByLabel = new Map<string, { dx: number; dy: number }>();
    const accumulate = (name: string, dx: number, dy: number): void => {
      const prev = pushByLabel.get(name) ?? { dx: 0, dy: 0 };
      pushByLabel.set(name, { dx: prev.dx + dx, dy: prev.dy + dy });
    };

    for (const ov of hard) {
      if (ov.kind === 'label-label') {
        const push = computeMinSeparation(ov.a.bbox, ov.b.bbox);
        accumulate(ov.a.name,  push.dx / 2,  push.dy / 2);
        accumulate(ov.b.name, -push.dx / 2, -push.dy / 2);
      } else if (ov.kind === 'component-label') {
        // One side is the label, the other is the component circle.
        const labelSide = ov.a.kind === 'label' ? ov.a : ov.b;
        const compSide  = ov.a.kind === 'label' ? ov.b : ov.a;
        const push = computeMinSeparation(labelSide.bbox, compSide.bbox);
        // Push only the label — components are frozen.
        accumulate(labelSide.name, push.dx, push.dy);
      } else if (ov.kind === 'label-canvas') {
        // ov.a is the label, ov.b is the synthetic canvas. Clamp
        // label inside the canvas rect.
        const lbl    = ov.a.bbox;
        const canvas = ov.b.bbox;
        let pushX = 0, pushY = 0;
        if (lbl.x < canvas.x) {
          pushX = canvas.x - lbl.x;
        } else if (lbl.x + lbl.width > canvas.x + canvas.width) {
          pushX = (canvas.x + canvas.width) - (lbl.x + lbl.width);
        }
        if (lbl.y < canvas.y) {
          pushY = canvas.y - lbl.y;
        } else if (lbl.y + lbl.height > canvas.y + canvas.height) {
          pushY = (canvas.y + canvas.height) - (lbl.y + lbl.height);
        }
        accumulate(ov.a.name, pushX, pushY);
      }
    }

    if (pushByLabel.size === 0) break;

    // Apply pushes in float — round only at the end of the function.
    for (const [name, push] of pushByLabel) {
      const lbl = floatLabels.get(name);
      if (!lbl) continue;
      lbl.dx += push.dx;
      lbl.dy += push.dy;
    }
  }

  // Emit — round float labels to integers.
  return {
    metadata: chain.metadata,
    links: chain.links,
    components: chain.components.map(c => {
      if (c.role === 'anchor') return c;
      const lbl = floatLabels.get(c.name);
      if (!lbl) return c;
      return {
        ...c,
        label: {
          dx: Math.round(lbl.dx),
          dy: Math.round(lbl.dy),
        },
      };
    }),
  };
}
