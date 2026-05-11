// Cross-framework label-placement strategy (ARCH-25).
//
// Wraps the deterministic `placeLabels` function (originally written for the
// Wardley chain pipeline) under the methodId
// `common:layout:write:labels:default`. The algorithm is purely topological
// — it does not depend on any Wardley-specific semantics — so it lives under
// the `common:` framework for reuse by climates, doctrines, and any future
// tool that needs to position labels around a 2D node layout.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { PositionedValueChain } from '#types/value-chain.mjs';
import { placeLabels } from '#frameworks/wardley/chain/_legacy/write/chain/lib/layout/place-labels.mjs';

const NEW_METHOD_ID_PLACE_LABELS = 'common:layout:write:labels:default';

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
