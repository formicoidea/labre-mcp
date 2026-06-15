// Real strategy `wardley:map:value-chain:select-by-type:component`.
//
// Selector engine: from a canonical WardleyMap, builds the array of analyzable
// inputs for nodes of `type: 'component'` ONLY. Anchors, markets, ecosystems and
// any other type are excluded — they are not analyzed by the per-component
// evolution positioner.
//
// This deliberately SEPARATES "iterate the chain by type" (this engine) from
// "analyze a single component" (position-functional-in-evolution:*). A recipe
// wires the two: it fans out the per-component positioner `over` this engine's
// output array. There is no bulk map-positioning strategy.
//
// Pure WardleyMap -> ComponentInput[]. Each canonical node is projected to the
// shape the per-component positioner consumes: `label.name` -> `name`,
// `description`, `nature`, and the map's business `context`.

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import { withoutRenderConfig } from '#schemas/render-config-passthrough.mjs';
import type { ComponentInput } from '#types/evolution.mjs';

const METHOD_ID = 'wardley:map:value-chain:select-by-type:component';

export class WardleyMapValueChainSelectByTypeComponentStrategy extends BaseStrategy<
  unknown,
  ComponentInput[]
> {
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<ComponentInput[]>> {
    const capturedAt = new Date().toISOString();
    const parsed = WardleyMapSchema.safeParse(withoutRenderConfig(input));
    if (!parsed.success) {
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          { text: "select-by-type: input is not a canonical WardleyMap", by: METHOD_ID, type: 'other' },
        ],
        result: [],
      };
    }
    const map = parsed.data;
    const mapContext = typeof map.context === 'string' ? map.context : undefined;

    const selected: ComponentInput[] = map.components
      .filter((c) => c.type === 'component')
      .map((c) => ({
        kind: 'capability' as const,
        name: c.label.name,
        ...(c.description ? { description: c.description } : {}),
        ...(mapContext ? { context: mapContext } : {}),
        ...(c.nature ? { nature: c.nature as ComponentInput['nature'] } : {}),
      }));

    return {
      signals: [
        { name: 'totalComponents', value: map.components.length, source: 'computed', capturedAt },
        { name: 'selectedType', value: 'component', source: 'computed', capturedAt },
        { name: 'selectedCount', value: selected.length, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: [
        {
          text: `Selected ${selected.length}/${map.components.length} nodes of type 'component' (anchors and other types excluded)`,
          by: METHOD_ID,
          type: 'other',
        },
      ],
      result: selected,
    };
  }
}
