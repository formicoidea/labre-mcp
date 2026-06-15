// Real strategy `wardley:map:value-chain:generate:top-down`.
//
// Fills a basemap skeleton into a full Wardley value chain using the top-down
// algorithm: anchor → needs → capabilities → dependency links, with a
// readability-only X layout. The natural-language prompt is read from the
// incoming canonical WardleyMap (basemap.title / .context); the output is again
// a canonical WardleyMap so the next recipe step (organized-y-position) can
// consume it verbatim.
//
// Two LLM calls (reused from the legacy write:chain pipeline):
//   1. extract-metadata — angle / scope / objective / imperatives / temporality.
//   2. generate-chain   — chain shape (anchor, components, links) + per-component
//                         `xHint` (visual clarity, NOT evolution maturity).
// Then two deterministic passes:
//   - computeVisibility — Y from the dependency DAG (strict parent-above-child).
//   - adjustX           — X readability around each xHint (anti-collision).
// The result is projected to the canonical WardleyMap by the render ACL, which
// reconciles the inverted visibility convention (see acl/value-chain.mts).
//
// X is a READABILITY layout here, never an evolution-maturity estimate — the
// evolution axis is only revealed later by the climate positioning commands
// (feedback_x_clarity_not_evolution).

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';
import { extractMetadata } from '#frameworks/wardley/chain/_legacy/write/chain/lib/llm/extract-metadata.mjs';
import { generateChain } from '#frameworks/wardley/chain/_legacy/write/chain/strategies/top-down/generate-chain.mjs';
import { computeVisibility } from '#frameworks/wardley/chain/_legacy/write/chain/lib/layout/compute-visibility.mjs';
import { adjustX } from '#frameworks/wardley/chain/_legacy/write/chain/lib/layout/adjust-x.mjs';
import { fromPositionedValueChain } from '#frameworks/render/wardley-map/acl/value-chain.mjs';

const METHOD_ID = 'wardley:map:value-chain:generate:top-down';

// View configuration this strategy bakes into the JSON-labre artefact. At the
// value-chain stage the X coordinate is a READABILITY layout, NOT an evolution
// maturity (feedback_x_clarity_not_evolution) — so the evolution (X) axis and
// its phase bands (Genesis/Custom-Built/Product/Commodity) are hidden by default
// to avoid implying a maturity that has not been assessed. The Value Chain (Y)
// axis stays visible. Maturity is only revealed later by the climate
// positioning commands, which re-show the axis. Kept in INPUT shape; it travels
// untouched through the layout steps and is resolved once at render time.
const VALUE_CHAIN_VIEW = { display: { axisEvolution: false, phases: false } } as const;

/** Recover the natural-language command from a canonical basemap WardleyMap.
 *  The basemap puts the prompt in `title` and the optional business context in
 *  `context`; both feed the metadata extraction. */
function readNlCommand(map: WardleyMap): string {
  const parts = [map.title, typeof map.context === 'string' ? map.context : '']
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.join('\n\n');
}

export class WardleyMapValueChainGenerateTopDownStrategy extends BaseStrategy<
  unknown,
  WardleyMap
> {
  private readonly _llmCall: LLMCall | null;

  constructor(options: { llmCall?: LLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<WardleyMap>> {
    const capturedAt = new Date().toISOString();

    // Degradation-first: an upstream mock may hand us a non-canonical object.
    const parsed = WardleyMapSchema.safeParse(input);
    if (!parsed.success) {
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: 'cannot generate value chain: input is not a canonical WardleyMap (basemap step not yet run?)',
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: WardleyMapSchema.parse({ title: 'Untitled map', components: [], relations: [] }),
      };
    }

    const nlCommand = readNlCommand(parsed.data);
    const llmCall: LLMCall = this._llmCall ?? getStrategyLLM('write-chain');

    // LLM #1 → metadata, LLM #2 → raw chain (anchor + needs + capabilities + links).
    const metadata = await extractMetadata(nlCommand, llmCall);
    const raw = await generateChain(metadata, llmCall);

    // Deterministic geometry: Y from the DAG, then X readability around xHint.
    const withY = computeVisibility(raw);
    const withX = adjustX(withY.chain);

    // Project to the canonical interchange type (ACL reconciles visibility),
    // then bake in the value-chain view (X axis hidden). The view is attached in
    // INPUT shape (not re-parsed) so it survives the layout steps unchanged; the
    // render command resolves it once.
    const map = { ...fromPositionedValueChain(withX.chain), renderConfig: VALUE_CHAIN_VIEW } as unknown as WardleyMap;

    const anchor = raw.components.find((c) => c.role === 'anchor');
    return {
      signals: [
        { name: 'nlCommand', value: nlCommand, source: 'user-input', capturedAt },
        { name: 'componentCount', value: map.components.length, source: 'computed', capturedAt },
        { name: 'linkCount', value: map.relations.length, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: anchor
        ? [{ text: `Value chain anchored on "${anchor.name}" (${map.components.length} components)`, by: METHOD_ID, type: 'other' }]
        : [],
      result: map,
    };
  }
}
