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
} from '../../../types/value-chain.mjs';
import type { EmitOwmOptions } from './emit-owm.mjs';
import {
  LABEL_CHAR_WIDTH,
  LABEL_HEIGHT,
  COMPONENT_RADIUS,
  type Bbox,
  type EdgeSegment,
  type SvgGeometry,
} from '../../../lib/owm/svg-bbox-parser.mjs';
import {
  computeGeometry,
  DEFAULT_MAP_WIDTH,
  DEFAULT_MAP_HEIGHT,
} from '../../../lib/owm/analytical-geometry.mjs';

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
