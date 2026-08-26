#!/usr/bin/env tsx
// The "geometry CLI" of the falsification test — the minimal deterministic tool
// posture C gets and posture B does not.
//
// It answers ONE question about a component: where does it sit in the value
// chain, and what crude prior does that position suggest on the evolution axis?
// No LLM, no network, no clock, no randomness: same map + same component ⇒ same
// bytes, forever.
//
// ── The leakage invariant ─────────────────────────────────────────────
// This tool reads `GoldMap`, which HAS NO evolution field — not masked, absent.
// So it cannot leak the answer, and neither can a future edit of it: there is
// nothing to read. Visibility (the other axis, the value chain) and the
// dependency graph are the whole of its input. `chain-geometry.test.mts` pins
// this by asserting the gold set carries no evolution outside `cases[].truth`.
//
// ── The prior is a guess, and the bench is what judges it ─────────────
// The mapping from "deep in the chain" to "far along evolution" is a crude
// monotone heuristic. It is NOT a claim about Wardley theory (the two axes are
// independent by construction). It is the challenger's tool, and whether it
// earns its place is exactly what the bench measures.
//
// Run: pnpm exec tsx --conditions labre-mcp-dev bench/geometry/chain-geometry.mts \
//        --map tea-shop --component brewing-equipment

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldMap } from '../bench.types.mjs';

export interface ChainGeometry {
  component: string;
  label: string;
  /** Shortest hop count from an anchor down to this component; null if unreachable. */
  depthFromAnchor: number | null;
  /** Deepest shortest-path depth in the whole map (the chain's length). */
  maxDepthInMap: number;
  /** depthFromAnchor / maxDepthInMap, in [0,1]. null when depth is null. */
  relativeDepth: number | null;
  /** Longest chain of suppliers still hanging BELOW this component. */
  depthBelow: number;
  /** How many components consume this one. */
  consumerCount: number;
  /** How many components this one consumes. */
  supplierCount: number;
  /** True when nothing sits below it — the bottom of the chain as drawn. */
  isLeaf: boolean;
  /** True when an anchor consumes it directly — a user-facing need. */
  isDirectUserNeed: boolean;
  /** Canonical visibility (0 = top of the chain). */
  visibility: number;
  /** Rank of the visibility among non-anchor components, normalised to [0,1]. */
  relativeVisibility: number;
  /** Crude prior interval on evolution, derived from position alone. */
  prior: { center: number; low: number; high: number };
  /** One line per fact, the wording posture C receives verbatim. */
  notes: string[];
}

/** Half-width of the prior interval. Wide on purpose: it is a position prior,
 *  not an estimate — a whole Wardley stage is 0.22 to 0.30 wide. */
const PRIOR_HALF_WIDTH = 0.15;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Shortest hop count from every anchor, following consumer → supplier edges. */
function depthsFromAnchors(map: GoldMap): Map<string, number> {
  const suppliers = new Map<string, string[]>();
  for (const edge of map.edges) {
    const list = suppliers.get(edge.consumer);
    if (list) list.push(edge.supplier);
    else suppliers.set(edge.consumer, [edge.supplier]);
  }
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const node of map.nodes) {
    if (node.type !== 'anchor') continue;
    depth.set(node.id, 0);
    queue.push(node.id);
  }
  // A map with no anchor at all: start from every node with no consumer.
  if (queue.length === 0) {
    const consumed = new Set(map.edges.map((e) => e.supplier));
    for (const node of map.nodes) {
      if (consumed.has(node.id)) continue;
      depth.set(node.id, 0);
      queue.push(node.id);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const currentDepth = depth.get(current) ?? 0;
    for (const supplier of suppliers.get(current) ?? []) {
      if (depth.has(supplier)) continue;
      depth.set(supplier, currentDepth + 1);
      queue.push(supplier);
    }
  }
  return depth;
}

/** Longest supplier chain hanging below `start`. Cycle-safe (visited set). */
function longestChainBelow(map: GoldMap, start: string): number {
  const suppliers = new Map<string, string[]>();
  for (const edge of map.edges) {
    const list = suppliers.get(edge.consumer);
    if (list) list.push(edge.supplier);
    else suppliers.set(edge.consumer, [edge.supplier]);
  }
  const seen = new Set<string>();
  const walk = (id: string): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let best = 0;
    for (const supplier of suppliers.get(id) ?? []) {
      best = Math.max(best, 1 + walk(supplier));
    }
    seen.delete(id);
    return best;
  };
  return walk(start);
}

export function computeChainGeometry(map: GoldMap, componentId: string): ChainGeometry {
  const node = map.nodes.find((n) => n.id === componentId);
  if (!node) throw new Error(`component "${componentId}" is not in map "${map.key}"`);

  const depths = depthsFromAnchors(map);
  const depthFromAnchor = depths.get(componentId) ?? null;
  const maxDepthInMap = Math.max(1, ...[...depths.values()]);
  const relativeDepth =
    depthFromAnchor === null ? null : round3(clamp(depthFromAnchor / maxDepthInMap, 0, 1));

  const consumerCount = map.edges.filter((e) => e.supplier === componentId).length;
  const supplierCount = map.edges.filter((e) => e.consumer === componentId).length;
  const anchorIds = new Set(map.nodes.filter((n) => n.type === 'anchor').map((n) => n.id));
  const isDirectUserNeed = map.edges.some(
    (e) => e.supplier === componentId && anchorIds.has(e.consumer),
  );

  // Visibility rank among non-anchor components: 0 = the most visible one.
  const componentNodes = map.nodes.filter((n) => n.type !== 'anchor');
  const sorted = [...componentNodes].sort(
    (a, b) => a.visibility - b.visibility || a.id.localeCompare(b.id),
  );
  const rank = sorted.findIndex((n) => n.id === componentId);
  const relativeVisibility =
    sorted.length <= 1 ? 0.5 : round3(rank / (sorted.length - 1));

  // The prior: the average of the two independent "how deep is it" signals,
  // nudged when the component is a leaf (nothing below it in the drawn chain).
  const positionScore = relativeDepth === null
    ? relativeVisibility
    : (relativeDepth + relativeVisibility) / 2;
  const isLeaf = supplierCount === 0;
  const center = round3(clamp(0.25 + 0.55 * positionScore + (isLeaf ? 0.05 : 0), 0.02, 0.98));

  const notes = [
    `depth from the user anchor: ${depthFromAnchor ?? 'unreachable'} hop(s) out of ${maxDepthInMap} in this map`,
    `${consumerCount} component(s) consume it, it consumes ${supplierCount}`,
    isLeaf
      ? 'nothing sits below it on this map: it is a bottom-of-chain supply'
      : `the longest supply chain below it is ${longestChainBelow(map, componentId)} hop(s)`,
    isDirectUserNeed
      ? 'a user anchor consumes it directly: it is a user-facing need'
      : 'no user anchor consumes it directly: it is an internal capability',
    `value-chain height: ${relativeVisibility} (0 = most visible component of the map, 1 = deepest)`,
    `positional prior on the evolution axis: ${center} ± ${PRIOR_HALF_WIDTH} ` +
      '(crude monotone heuristic, position only — no knowledge of the component itself)',
  ];

  return {
    component: componentId,
    label: node.label,
    depthFromAnchor,
    maxDepthInMap,
    relativeDepth,
    depthBelow: longestChainBelow(map, componentId),
    consumerCount,
    supplierCount,
    isLeaf,
    isDirectUserNeed,
    visibility: node.visibility,
    relativeVisibility,
    prior: {
      center,
      low: round3(clamp(center - PRIOR_HALF_WIDTH, 0.02, 0.98)),
      high: round3(clamp(center + PRIOR_HALF_WIDTH, 0.02, 0.98)),
    },
    notes,
  };
}

/** The prose form posture C's prompt carries. */
export function formatChainGeometry(geometry: ChainGeometry): string {
  return geometry.notes.map((note) => `- ${note}`).join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────

export function parseCliArgs(argv: readonly string[]): { map: string; component: string } {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = (eq >= 0 ? arg.slice(0, eq) : arg).replace(/^--/, '');
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new Error(`--${name} expects a value`);
    options[name] = value;
  }
  if (!options.map || !options.component) {
    throw new Error('usage: chain-geometry.mts --map <mapKey> --component <componentId>');
  }
  return { map: options.map, component: options.component };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { loadGoldSet } = await import('../gold/build-gold-set.mjs');
  const { map: mapKey, component } = parseCliArgs(process.argv.slice(2));
  const goldSet = loadGoldSet();
  const map = goldSet.maps[mapKey];
  if (!map) {
    throw new Error(`unknown map "${mapKey}" (known: ${Object.keys(goldSet.maps).join(', ')})`);
  }
  process.stdout.write(`${JSON.stringify(computeChainGeometry(map, component), null, 2)}\n`);
}
