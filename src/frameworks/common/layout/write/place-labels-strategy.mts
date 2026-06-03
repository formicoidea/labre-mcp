// Wardley map value-chain label-placement strategy.
//
// Wraps the deterministic `placeLabels` function (originally written for the
// Wardley chain pipeline) under the methodId
// `wardley:map:value-chain:prevent-collision:default` (ast-schema.md v0.1.0).
// The algorithm itself is purely topological and framework-agnostic — the
// file location under src/frameworks/common/ is preserved for this checkpoint;
// physical relocation to src/frameworks/wardley/map/value-chain/ is deferred.
// If a future tool needs the algorithm cross-framework, it will be extracted
// to a true common:layout:* entry then.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { PositionedValueChain } from '#types/value-chain.mjs';
import { placeLabels } from '#frameworks/wardley/chain/_legacy/write/chain/lib/layout/place-labels.mjs';

const NEW_METHOD_ID_PLACE_LABELS = 'wardley:map:value-chain:prevent-collision:default';

export interface PlaceLabelsInput {
  chain: PositionedValueChain;
}

export interface PlaceLabelsResult {
  chain: PositionedValueChain;
}

export class PlaceLabelsStrategy extends CoreBaseStrategy<PlaceLabelsInput, PlaceLabelsResult> {
  static get method(): string {
    return NEW_METHOD_ID_PLACE_LABELS;
  }

  async evaluate(
    input: PlaceLabelsInput,
    _context: RequestContext,
  ): Promise<StrategyResult<PlaceLabelsResult>> {
    if (!input?.chain) {
      throw new Error('PlaceLabelsStrategy: requires a `chain` input');
    }
    const placed = placeLabels(input.chain);
    const capturedAt = new Date().toISOString();
    return {
      signals: [
        { name: 'component-count', value: input.chain.components.length, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: [],
      result: { chain: placed },
    };
  }
}
