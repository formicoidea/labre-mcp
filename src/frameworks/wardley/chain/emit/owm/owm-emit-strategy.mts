// OWM DSL emitter strategy.
//
// Wraps `generateChainOwmSyntax` (the deterministic AST → OWM DSL pass used
// by the top-down chain pipeline) so recipes can call it under the methodId
// `render:wardley-map:owm:emit:dsl` (ast-schema.md v0.1.0).
//
// Input is the same `PositionedValueChain` shape the layout strategies
// operate on; output is the OWM DSL string ready to render or persist.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { PositionedValueChain } from '#types/value-chain.mjs';
import {
  generateChainOwmSyntax,
  type EmitOwmOptions,
} from '#frameworks/wardley/chain/_legacy/write/chain/lib/emit/emit-owm.mjs';

const NEW_METHOD_ID_OWM_EMIT = 'render:wardley-map:owm:emit:dsl';

export interface OwmEmitInput {
  chain: PositionedValueChain;
  emit?: EmitOwmOptions;
}

export interface OwmEmitResult {
  dsl: string;
}

export class OwmEmitStrategy extends CoreBaseStrategy<OwmEmitInput, OwmEmitResult> {
  static get method(): string {
    return NEW_METHOD_ID_OWM_EMIT;
  }

  async evaluate(
    input: OwmEmitInput,
    _context: RequestContext,
  ): Promise<StrategyResult<OwmEmitResult>> {
    if (!input?.chain) {
      throw new Error('OwmEmitStrategy: requires a `chain` input');
    }
    const dsl = generateChainOwmSyntax(input.chain, input.emit ?? {});
    const capturedAt = new Date().toISOString();
    return {
      signals: [
        { name: 'component-count', value: input.chain.components.length, source: 'computed', capturedAt },
        ...(input.emit?.style
          ? [{ name: 'style', value: input.emit.style, source: 'user-input' as const, capturedAt }]
          : []),
      ],
      reasoning: [],
      insights: [],
      result: { dsl },
    };
  }
}
