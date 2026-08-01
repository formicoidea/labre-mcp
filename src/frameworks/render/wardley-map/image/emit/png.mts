// Real strategy `render:wardley-map:image:emit:png`.
//
// Consumes a canonical WardleyMap (the structured object carried by JSON-labre)
// and renders it DIRECTLY to PNG via the renderer package's own engine
// (`renderToPNG`, async — it loads fonts and rasterises the SVG through resvg).
// No OWM DSL, no cli-owm, no intermediate object model — the package's schema
// IS labre's canonical schema.
//
// The PNG bytes are handed back as base64 so the result stays JSON-serialisable
// across the MCP envelope (Buffer would not survive the transport).
//
// Graceful by design (degradation-first): during the incremental migration an
// upstream step may still be a mock and hand us a non-canonical object. Rather
// than crash the recipe, we emit an insight flagging it and return an empty
// payload (rendered: false).

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema } from '#schemas/wardley-map.schema.mjs';
import { readRenderConfig, withoutRenderConfig } from '#schemas/render-config-passthrough.mjs';
import { renderToPNG } from '@formicoidea/wardley-map-renderer';

const METHOD_ID = 'render:wardley-map:image:emit:png';

export interface RenderWardleyMapImageEmitPngResult {
  /** Base64-encoded PNG bytes ('' when the input could not be rendered). */
  pngBase64: string;
  rendered: boolean;
}

export class RenderWardleyMapImageEmitPngStrategy extends BaseStrategy<
  unknown,
  RenderWardleyMapImageEmitPngResult
> {
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<RenderWardleyMapImageEmitPngResult>> {
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
        result: { pngBase64: '', rendered: false },
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
    const png = await renderToPNG(toRender);

    return {
      signals: [
        { name: 'componentCount', value: parsed.data.components.length, source: 'computed', capturedAt },
        { name: 'byteLength', value: png.byteLength, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: [],
      result: { pngBase64: png.toString('base64'), rendered: true },
    };
  }
}
