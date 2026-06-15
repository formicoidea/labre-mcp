// Wardley map value-chain label de-collision step
// `wardley:map:value-chain:prevent-collision:default` (ast-schema.md v0.1.0).
//
// BLIND by design: this strategy owns no pixel geometry. Label placement needs
// font metrics and the canvas size, which are the render command's concern, not
// a layout strategy's. Its single job is to UN-PIN every label (drop any
// `label.position`): a label that carries a position is treated as "pinned" and
// is skipped by the renderer's collision avoidance. Un-pinning hands placement
// to the render command (`render:wardley-map:image:emit:svg`), which turns its
// own multi-directional avoidance on and positions each label (right / left /
// top / bottom) while pushing apart residual overlaps — the natural look.
//
// The upstream depth-band layout (organized-y-position) already guarantees nodes
// never overlap, which gives the renderer's avoidance room to keep every label
// readable and close to its node. Pure WardleyMap → WardleyMap.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { readRenderConfig, withoutRenderConfig } from '#schemas/render-config-passthrough.mjs';

const NEW_METHOD_ID_PLACE_LABELS = 'wardley:map:value-chain:prevent-collision:default';

export class PlaceLabelsStrategy extends CoreBaseStrategy<unknown, WardleyMap> {
  static get method(): string {
    return NEW_METHOD_ID_PLACE_LABELS;
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
          { text: 'cannot configure labels: input is not a canonical WardleyMap', by: NEW_METHOD_ID_PLACE_LABELS, type: 'other' },
        ],
        result: WardleyMapSchema.parse({ title: 'Untitled map', components: [], relations: [] }),
      };
    }
    const map = parsed.data;

    const laid = WardleyMapSchema.parse({
      ...map,
      // Un-pin labels so the renderer is free to reposition them. A label with a
      // `position` is treated as pinned and skipped by the renderer's avoidance.
      components: map.components.map((c) => ({ ...c, label: { name: c.label.name } })),
    });
    const result = (view ? { ...laid, renderConfig: view } : laid) as WardleyMap;

    return {
      signals: [
        { name: 'componentCount', value: map.components.length, source: 'computed', capturedAt },
        { name: 'labelsUnpinned', value: true, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: [
        { text: 'labels un-pinned — placement delegated to the render command (avoidCollisions)', by: NEW_METHOD_ID_PLACE_LABELS, type: 'other' },
      ],
      result,
    };
  }
}
