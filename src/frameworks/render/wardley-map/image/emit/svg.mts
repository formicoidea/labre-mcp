// Real strategy `render:wardley-map:image:emit:svg`.
//
// Consumes a canonical WardleyMap (the structured object carried by JSON-labre)
// and renders it DIRECTLY to SVG via the renderer package's own engine
// (`renderToSVG`, synchronous). No OWM DSL, no cli-owm, no intermediate object
// model — the package's schema IS labre's canonical schema.
//
// DOCUMENTED LOSSES (surfaced as insights, one per distinct reason — the same
// accumulator contract as `owm:emit:dsl`): a subtype WITHOUT a dedicated symbol
// (everything but market/ecosystem, whose ambiguity `parse:svg` warns about
// itself), `nature` (never drawn), and `label.position` offsets (collision
// avoidance repositions labels, so an offset cannot be recovered from the
// pixels). These constructions vanish from the SVG round-trip, and only the
// emitter can say so — the parser sees nothing to warn about.
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

// Subtypes the renderer draws with a dedicated symbol (componentRenderableType
// in @formicoidea/wardley-map-renderer). Their drop is `parse:svg`'s to report
// (it recognises the symbol but cannot restore the subtype); every OTHER
// subtype renders as the generic component glyph and is lost right here.
const SYMBOL_SUBTYPES: ReadonlySet<string> = new Set(['market', 'ecosystem']);

/** Accumulate one insight per distinct loss reason (never one per component). */
function note(losses: Map<string, number>, reason: string): void {
  losses.set(reason, (losses.get(reason) ?? 0) + 1);
}

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

    // Declare what this render is about to lose BEFORE drawing: these fields
    // leave no recoverable trace in the SVG, so silence here would be a silent
    // drop for the whole round-trip.
    const losses = new Map<string, number>();
    for (const c of parsed.data.components) {
      if ((c.subtype !== undefined && !SYMBOL_SUBTYPES.has(c.subtype)) || c.nature !== undefined) {
        note(losses, 'component taxonomy (subtype/nature) has no distinct SVG symbol and was dropped');
      }
      if (c.label.position !== undefined) {
        note(losses, 'label offsets (label.position) are not recoverable from an SVG render and were dropped');
      }
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
      insights: [...losses.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([reason, count]) => ({
          text: count > 1 ? `${reason} (${count} occurrences)` : reason,
          by: METHOD_ID,
          type: 'other' as const,
        })),
      result: { svg, rendered: true },
    };
  }
}
