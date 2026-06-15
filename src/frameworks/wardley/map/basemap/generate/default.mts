// Real strategy `wardley:map:basemap:generate:default`.
//
// Produces the canonical WardleyMap *skeleton* a study starts from: a title, an
// optional context string, and empty components/relations. The value-chain
// generator fills the components later. Deterministic — no LLM. The canonical
// shape is the renderer package's schema (label.name, position.{evolution,
// visibility}.scalar, …); the structured business context (purpose/scope/angle/
// temporality) belongs to the JSON-labre envelope, not to map.context (a string).

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';

const METHOD_ID = 'wardley:map:basemap:generate:default';

export interface BasemapGenerateInput {
  prompt?: string;
  title?: string;
  // Business context: a string summary, or a structured object whose `purpose`
  // seeds the title. The structured context itself lives in the envelope.
  context?: unknown;
}

function readContextString(context: unknown): string | undefined {
  if (typeof context === 'string') return context.trim() || undefined;
  if (context && typeof context === 'object' && 'purpose' in context) {
    const p = (context as { purpose?: unknown }).purpose;
    if (typeof p === 'string') return p.trim() || undefined;
  }
  return undefined;
}

export class WardleyMapBasemapGenerateDefaultStrategy extends BaseStrategy<
  BasemapGenerateInput,
  WardleyMap
> {
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: BasemapGenerateInput,
    _context: RequestContext,
  ): Promise<StrategyResult<WardleyMap>> {
    const capturedAt = new Date().toISOString();

    const contextStr = readContextString(input?.context);
    const rawTitle = (input?.title ?? input?.prompt ?? contextStr ?? '').trim();
    const title = rawTitle.length > 0 ? rawTitle : 'Untitled map';

    const map = WardleyMapSchema.parse({
      title,
      ...(contextStr ? { context: contextStr } : {}),
      components: [],
      relations: [],
    });

    return {
      signals: [{ name: 'hasContext', value: contextStr !== undefined, source: 'user-input', capturedAt }],
      reasoning: [],
      insights: [
        { text: 'basemap skeleton generated (components empty; fill via value-chain:generate)', by: METHOD_ID, type: 'other' },
      ],
      result: map,
    };
  }
}
