// Real strategy `render:wardley-map:image:emit:svg`.
//
// Consumes a canonical WardleyMap (the structured object carried by JSON-labre)
// and renders it DIRECTLY to SVG via the renderer package's own engine
// (`renderToSVG`, synchronous). No OWM DSL, no cli-owm, no intermediate object
// model — the package's schema IS labre's canonical schema.
//
// Graceful by design (degradation-first): during the incremental migration an
// upstream step may still be a mock and hand us a non-canonical object. Rather
// than crash the recipe, we emit an insight flagging it and return an empty SVG
// (rendered: false).

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import { readRenderConfig, withoutRenderConfig } from '#schemas/render-config-passthrough.mjs';
import { renderToSVG } from '@formicoidea/wardley-map-renderer';

const METHOD_ID = 'render:wardley-map:image:emit:svg';

export interface RenderWardleyMapImageEmitSvgResult {
  svg: string;
  rendered: boolean;
}

export class RenderWardleyMapImageEmitSvgStrategy extends BaseStrategy<
  unknown,
  RenderWardleyMapImageEmitSvgResult
> {
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<RenderWardleyMapImageEmitSvgResult>> {
    const capturedAt = new Date().toISOString();
    // The upstream view config travels in INPUT shape; strip it before validating
    // the geometry, then resolve it ONCE here (merged with collision avoidance).
    const view = readRenderConfig(input);
    const parsed = WardleyMapSchema.safeParse(withoutRenderConfig(input));

    if (!parsed.success) {
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: 'cannot render: input is not a canonical WardleyMap (upstream step not yet promoted?)',
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: { svg: '', rendered: false },
      };
    }

    // Merge the caller's view (e.g. value-chain hides the evolution X axis) with
    // the renderer's multi-directional label collision avoidance, then resolve
    // the whole renderConfig in a single parse (input shape → renderer output).
    const viewObj = (view && typeof view === 'object' ? view : {}) as Record<string, unknown>;
    const rendering = { ...(viewObj.rendering as Record<string, unknown> | undefined), avoidCollisions: true };
    const toRender = WardleyMapSchema.parse({
      ...parsed.data,
      renderConfig: { ...viewObj, rendering },
    });
    const svg = renderToSVG(toRender);

    return {
      signals: [
        { name: 'componentCount', value: parsed.data.components.length, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: [],
      result: { svg, rendered: true },
    };
  }
}
