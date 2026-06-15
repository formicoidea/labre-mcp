// Readability regression for the draw-value-chain layout + render steps.
//
// Drives the real organized-y-position → prevent-collision → SVG-emit command
// over a frozen 24-component teashop map (a real generate:top-down output) and
// asserts the RENDERED SVG is readable. Measurement parses the SVG produced by
// the render command itself (node circles + label texts) — no layout strategy
// and no test geometry assumes pixel positions; we read what was actually drawn.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { WardleyMapValueChainOrganizedYPositionDefaultStrategy } from './organized-y-position/default.mjs';
import { PlaceLabelsStrategy } from '#frameworks/common/layout/write/place-labels-strategy.mjs';
import { RenderWardleyMapImageEmitSvgStrategy } from '#frameworks/render/wardley-map/image/emit/svg.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const ctx = {} as RequestContext;
const here = dirname(fileURLToPath(import.meta.url));
const fixture = WardleyMapSchema.parse(
  JSON.parse(readFileSync(join(here, '__fixtures__/teashop.wardley-map.json'), 'utf8')),
);

const R = 5, CW = 7, LH = 16;
interface Pt { cx: number; cy: number; }
interface Box { left: number; top: number; right: number; bottom: number; }
interface Lbl { x: number; y: number; text: string; b: Box; }

// Slice one SVG layer's markup by its data-layer marker.
function layer(svg: string, name: string): string {
  const s = svg.indexOf(`<g data-layer="${name}">`);
  if (s === -1) return '';
  const next = svg.indexOf('<g data-layer="', s + 1);
  return svg.slice(s, next === -1 ? undefined : next);
}
function parseNodes(svg: string): Pt[] {
  const part = layer(svg, 'nodes');
  const re = /<circle\s+cx="([-\d.]+)"\s+cy="([-\d.]+)"\s+r="5"/g;
  const out: Pt[] = []; let m: RegExpExecArray | null;
  while ((m = re.exec(part))) out.push({ cx: +m[1], cy: +m[2] });
  return out;
}
function parseLabels(svg: string): Lbl[] {
  const part = layer(svg, 'labels');
  const re = /<text[^>]*\bx="([-\d.]+)"[^>]*\by="([-\d.]+)"[^>]*text-anchor="(start|end|middle)"[^>]*>([^<]*)<\/text>/g;
  const out: Lbl[] = []; let m: RegExpExecArray | null;
  while ((m = re.exec(part))) {
    const x = +m[1], y = +m[2], anchor = m[3], text = m[4];
    const w = text.length * CW;
    const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    const right = anchor === 'start' ? x + w : anchor === 'end' ? x : x + w / 2;
    out.push({ x, y, text, b: { left, right, top: y - LH * 0.7, bottom: y + LH * 0.3 } });
  }
  return out;
}
function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
function nearestNodeDist(p: { x: number; y: number }, nodes: Pt[]): number {
  return Math.min(...nodes.map((n) => Math.hypot(n.cx - p.x, n.cy - p.y)));
}

async function organizeY(map: WardleyMap): Promise<WardleyMap> {
  return WardleyMapSchema.parse((await new WardleyMapValueChainOrganizedYPositionDefaultStrategy().evaluate(map, ctx)).result);
}
async function renderPipeline(map: WardleyMap): Promise<string> {
  const y = await organizeY(map);
  const laid = WardleyMapSchema.parse((await new PlaceLabelsStrategy().evaluate(y, ctx)).result);
  const out = await new RenderWardleyMapImageEmitSvgStrategy().evaluate(laid, ctx);
  assert.ok(out.result.rendered, 'render command produced an SVG');
  return out.result.svg;
}

// Assert the rendered SVG is readable: one node + one label per component, no
// circle overlaps, no label overlaps, no label over a foreign node, and every
// label hugging a node. (Legend lives in its own layer, so it never affects
// these node/label measurements.)
function assertReadable(svg: string, expectedCount: number): void {
  const nodes = parseNodes(svg);
  const labels = parseLabels(svg);
  assert.equal(nodes.length, expectedCount, 'one node circle per component');
  assert.equal(labels.length, expectedCount, 'one label per component');

  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].cx - nodes[j].cx, nodes[i].cy - nodes[j].cy);
      assert.ok(d >= 2 * R, `circles overlap (gap ${d.toFixed(1)}px)`);
    }
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      assert.ok(!boxesOverlap(labels[i].b, labels[j].b), `labels overlap: "${labels[i].text}" / "${labels[j].text}"`);
  for (const lb of labels)
    for (const n of nodes) {
      const inBox = n.cx > lb.b.left - R && n.cx < lb.b.right + R && n.cy > lb.b.top - R && n.cy < lb.b.bottom + R;
      if (!inBox) continue;
      const own = nearestNodeDist({ x: lb.x, y: lb.y }, nodes);
      assert.ok(Math.hypot(n.cx - lb.x, n.cy - lb.y) <= own + 1e-6, `label "${lb.text}" covers a foreign node`);
    }
  for (const lb of labels)
    assert.ok(nearestNodeDist({ x: lb.x, y: lb.y }, nodes) <= 60, `label "${lb.text}" detached from any node`);
}

describe('draw-value-chain layout readability (teashop fixture, measured from the render command)', () => {
  it('renders with no circle overlaps, no label overlaps, and labels close to their node', async () => {
    assertReadable(await renderPipeline(fixture), fixture.components.length);
  });

  it('keeps the value-chain top-down (every dependency edge: consumer above supplier)', async () => {
    const y = await organizeY(fixture);
    const vis = new Map(y.components.map((c) => [c.id, c.position.visibility.scalar]));
    for (const r of y.relations)
      assert.ok(vis.get(r.consumer)! <= vis.get(r.supplier)!, `edge ${r.consumer}->${r.supplier} not top-down`);
  });
});

// Two value chains (two anchors) joined at two shared points — the same layout
// quality must hold when the graph is a forest with cross-chain junctions.
const twoAnchor = WardleyMapSchema.parse(
  JSON.parse(readFileSync(join(here, '__fixtures__/two-anchor.wardley-map.json'), 'utf8')),
);

describe('two connected value chains (two anchors, two shared junctions)', () => {
  it('renders both chains overlap-free with labels close to their node', async () => {
    assertReadable(await renderPipeline(twoAnchor), twoAnchor.components.length);
  });

  it('roots both anchors on the top band and keeps two cross-chain junctions', async () => {
    const y = await organizeY(twoAnchor);
    const anchors = y.components.filter((c) => c.type === 'anchor');
    assert.equal(anchors.length, 2, 'two value chains => two anchors');
    const topY = Math.min(...y.components.map((c) => c.position.visibility.scalar));
    for (const a of anchors)
      assert.equal(a.position.visibility.scalar, topY, 'both anchors sit on the top band');

    // The two junction nodes are each depended on by more than one parent — the
    // points where the two chains connect.
    const indeg = new Map<string, number>();
    for (const r of y.relations) indeg.set(r.supplier, (indeg.get(r.supplier) ?? 0) + 1);
    const junctions = [...indeg.values()].filter((n) => n >= 2).length;
    assert.ok(junctions >= 2, `expected >= 2 shared junctions, got ${junctions}`);

    // Every edge still renders top-down across both chains.
    const vis = new Map(y.components.map((c) => [c.id, c.position.visibility.scalar]));
    for (const r of y.relations)
      assert.ok(vis.get(r.consumer)! <= vis.get(r.supplier)!, `edge ${r.consumer}->${r.supplier} not top-down`);
  });
});
