// OWM DSL parser strategy.
//
// Wraps the vendored cli-owm parser (src/lib/vendor/cli-owm) to expose it
// behind the core BaseStrategy contract. Recipes reference this strategy
// by methodId `wardley:chain:read:map:owm-parser`.
//
// V1 output is the cli-owm UnifiedWardleyMap with a thin labre-mcp envelope
// (title, parse errors). A richer mapping to the canonical WardleyChainAST
// (resolving every UnifiedComponent into the labre-mcp Component schema) is
// V1.5+ work; for V1 the contract is registry resolution + invocability.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { parse, type UnifiedWardleyMap } from '#lib/vendor/cli-owm/index.mjs';

const NEW_METHOD_ID_OWM_PARSER = 'wardley:chain:read:map:owm-parser';

export interface OwmParserInput {
  dsl: string;
}

export interface OwmParserResult {
  title: string;
  // any: UnifiedWardleyMap is the open cli-owm parse output — surface as-is.
  map: UnifiedWardleyMap;
  componentCount: number;
  errorCount: number;
}

export class OwmParserStrategy extends CoreBaseStrategy<OwmParserInput, OwmParserResult> {
  static get method(): string {
    return NEW_METHOD_ID_OWM_PARSER;
  }

  async evaluate(
    input: OwmParserInput,
    _context: RequestContext,
  ): Promise<StrategyResult<OwmParserResult>> {
    if (!input?.dsl || typeof input.dsl !== 'string') {
      throw new Error('OwmParserStrategy: requires a non-empty `dsl` string input');
    }
    const map = parse(input.dsl);
    const capturedAt = new Date().toISOString();
    return {
      signals: [
        { name: 'dsl-bytes', value: input.dsl.length, source: 'user-input', capturedAt },
      ],
      reasoning: [],
      insights: map.errors.length > 0
        ? [{
            text: `Parser surfaced ${map.errors.length} error(s); downstream strategies may need to compensate.`,
            by: NEW_METHOD_ID_OWM_PARSER,
            type: 'other',
          }]
        : [],
      result: {
        title: map.title,
        map,
        componentCount: map.components.length + map.anchors.length,
        errorCount: map.errors.length,
      },
    };
  }
}
