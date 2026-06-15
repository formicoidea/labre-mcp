// Real strategy `wardley:map:value-chain:organized-y-position:default`.
//
// Produces a NATURAL value-chain layout: a depth-banded tree, the way a Wardley
// practitioner draws one by hand — the anchor at the top, its needs fanning out
// on the band just below, their capabilities on the next band, and so on.
//
//   1. Longest-path layering over the dependency DAG (consumer → supplier).
//      Every `A -> B` edge gives depth(B) >= depth(A)+1, so a supplier is always
//      strictly below everything that depends on it (parent-above-child).
//   2. Y band per depth — all nodes of the same depth share a horizontal level,
//      evenly spaced in [Y_TOP, Y_BOT]. This is what gives the organic, tree-like
//      shape instead of a rigid one-node-per-row ladder.
//   3. X by Sugiyama coordinate assignment, band by band, top first:
//        - ORDER each band by the barycentre (mean X) of each node's parents, so
//          a child sits under its parents instead of on the opposite side;
//        - POSITION by blending that barycentre (BARY_WEIGHT — straight edges)
//          with an even spread across the width (label room). Sources/orphans
//          have no parent, so they take the even position and seed the order by
//          their incoming X. A min-gap sweep then guarantees no two circles in a
//          band share a pixel.
//
// Deliberately BLIND: works purely in normalized [0,1] space from the relation
// graph — it knows nothing about pixels, fonts or canvas size. Label de-collision
// is NOT done here; it is delegated to the render command (prevent-collision
// un-pins labels and turns on the renderer's own multi-directional avoidance).
//
// Pure WardleyMap → WardleyMap. Idempotent: every coordinate is a function of the
// graph structure (depths, parent barycentres, rank-based spread) plus a stable
// order, so re-running reproduces the same layout. No anchor is required —
// longest-path layering roots at every in-degree-0 source.

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { readRenderConfig, withoutRenderConfig } from '#schemas/render-config-passthrough.mjs';

const METHOD_ID = 'wardley:map:value-chain:organized-y-position:default';

// Normalized layout band (leaves a small margin off each axis).
const Y_TOP = 0.05;
const Y_BOT = 0.95;
const X_LEFT = 0.08;
const X_RIGHT = 0.92;
// Minimum horizontal gap between two nodes sharing a band (~31px on a 1552px
// plot — comfortably above the 10px circle diameter).
const MIN_DX = 0.02;
// How strongly a child is pulled under its parents' barycentre (1 = straight
// under, 0 = pure even spread). 0.5 balances readable edges (children under
// their parents) against enough width for labels — it keeps crowded bands and
// multi-anchor maps (two chains sharing nodes) overlap-free.
const BARY_WEIGHT = 0.5;

/** Longest-path depth per component id over the relation DAG (sources = 0). */
function longestPathDepth(map: WardleyMap): Map<string, number> {
  const ids = map.components.map((c) => c.id);
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const r of map.relations) {
    if (!children.has(r.consumer) || !children.has(r.supplier)) continue; // dangling relation
    children.get(r.consumer)!.push(r.supplier);
    indeg.set(r.supplier, (indeg.get(r.supplier) ?? 0) + 1);
  }
  const ind = new Map(indeg);
  const queue = ids.filter((id) => (ind.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of children.get(u) ?? []) {
      ind.set(v, (ind.get(v) ?? 0) - 1);
      if (ind.get(v) === 0) queue.push(v);
    }
  }
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const u of order)
    for (const v of children.get(u) ?? [])
      depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(u) ?? 0) + 1));
  return depth;
}

export class WardleyMapValueChainOrganizedYPositionDefaultStrategy extends BaseStrategy<
  unknown,
  WardleyMap
> {
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<WardleyMap>> {
    const capturedAt = new Date().toISOString();

    // Preserve the upstream view config (input shape) untouched across this step.
    const view = readRenderConfig(input);
    const parsed = WardleyMapSchema.safeParse(withoutRenderConfig(input));
    if (!parsed.success) {
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          { text: 'cannot organise layout: input is not a canonical WardleyMap', by: METHOD_ID, type: 'other' },
        ],
        result: WardleyMapSchema.parse({ title: 'Untitled map', components: [], relations: [] }),
      };
    }
    const map = parsed.data;
    if (map.components.length === 0) {
      return {
        signals: [{ name: 'componentCount', value: 0, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [{ text: 'layout left unchanged: empty map', by: METHOD_ID, type: 'other' }],
        result: map,
      };
    }

    const depth = longestPathDepth(map);
    const maxDepth = Math.max(1, ...depth.values());

    // Band Y by depth.
    const yById = new Map<string, number>();
    for (const c of map.components)
      yById.set(c.id, Y_TOP + (depth.get(c.id)! / maxDepth) * (Y_BOT - Y_TOP));

    // X assignment, band by band from the top. Parents (shallower depth) are
    // always placed before their children, so a child's barycentre is known.
    const ownX = new Map(map.components.map((c) => [c.id, c.position.evolution.scalar]));
    const parents = new Map<string, string[]>(map.components.map((c) => [c.id, []]));
    for (const r of map.relations) parents.get(r.supplier)?.push(r.consumer); // consumer is the parent (above)

    const bands = new Map<number, string[]>();
    for (const c of map.components) {
      const d = depth.get(c.id)!;
      (bands.get(d) ?? bands.set(d, []).get(d)!).push(c.id);
    }

    const xById = new Map<string, number>();
    for (let d = 0; d <= maxDepth; d++) {
      const ids = bands.get(d) ?? [];
      // Barycentre of each node's already-placed parents (null = source/orphan).
      const bary = new Map<string, number | null>();
      for (const id of ids) {
        const placed = (parents.get(id) ?? []).filter((p) => xById.has(p));
        bary.set(id, placed.length ? placed.reduce((s, p) => s + xById.get(p)!, 0) / placed.length : null);
      }
      // Order under the parents; sources keep their incoming X order (used for
      // ORDER only — the position is rank-based below, so it stays stable).
      ids.sort((a, b) =>
        (bary.get(a) ?? ownX.get(a)!) - (bary.get(b) ?? ownX.get(b)!) || ownX.get(a)! - ownX.get(b)!);
      const n = ids.length;
      ids.forEach((id, i) => {
        const even = n === 1 ? (X_LEFT + X_RIGHT) / 2 : X_LEFT + (i * (X_RIGHT - X_LEFT)) / (n - 1);
        const b = bary.get(id);
        xById.set(id, b == null ? even : BARY_WEIGHT * b + (1 - BARY_WEIGHT) * even);
      });
      // Min-gap sweep, then shift the band left if it overran the right margin.
      let prev = -Infinity;
      for (const id of ids) {
        let x = Math.max(X_LEFT, xById.get(id)!);
        if (x - prev < MIN_DX) x = prev + MIN_DX;
        xById.set(id, x);
        prev = x;
      }
      const overflow = (xById.get(ids[n - 1]) ?? 0) - X_RIGHT;
      if (overflow > 0) for (const id of ids) xById.set(id, xById.get(id)! - overflow);
      for (const id of ids) xById.set(id, Math.max(X_LEFT, Math.min(X_RIGHT, xById.get(id)!)));
    }

    const laid = WardleyMapSchema.parse({
      ...map,
      components: map.components.map((c) => ({
        ...c,
        position: {
          ...c.position,
          evolution: { ...c.position.evolution, scalar: xById.get(c.id)! },
          visibility: { scalar: yById.get(c.id)! },
        },
      })),
    });
    // Re-attach the upstream view config (input shape) untouched.
    const result = (view ? { ...laid, renderConfig: view } : laid) as WardleyMap;

    return {
      signals: [
        { name: 'componentCount', value: map.components.length, source: 'computed', capturedAt },
        { name: 'bandCount', value: maxDepth + 1, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: [
        { text: `Layout organised into ${maxDepth + 1} value-chain bands (depth layering, within-band X de-collision)`, by: METHOD_ID, type: 'other' },
      ],
      result,
    };
  }
}
