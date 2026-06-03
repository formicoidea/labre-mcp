// Wardley map value-chain overlap audit strategy.
//
// Wraps the `verifyLayout` pipeline (force-directed labels + component nudge
// + canonical snap + strict projection) and surfaces residual overlap counts
// under the methodId `wardley:map:value-chain:audit:overlap-check`
// (ast-schema.md v0.1.0). Typically attached as a listener of
// `wardley:map:value-chain:prevent-collision:default` to flag any residual
// overlaps that the placement pass could not resolve.
//
// The algorithm is geometry-only and framework-agnostic; file location
// preserved for this checkpoint, physical relocation deferred.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { PositionedValueChain } from '#types/value-chain.mjs';
import {
  verifyLayout,
  type VerifyReport,
} from '#frameworks/wardley/chain/_legacy/write/chain/lib/layout/verify-layout.mjs';
import type { EmitOwmOptions } from '#frameworks/wardley/chain/_legacy/write/chain/lib/emit/emit-owm.mjs';

const NEW_METHOD_ID_OVERLAP_CHECK = 'wardley:map:value-chain:audit:overlap-check';

export interface OverlapCheckInput {
  chain: PositionedValueChain;
  emit?: EmitOwmOptions;
}

export interface OverlapCheckResult {
  chain: PositionedValueChain;
  unresolvedHard: number;
  unresolvedSpacing: number;
  unresolvedEdge: number;
  unresolvedAxis: number;
  iterations: number;
}

export class OverlapCheckStrategy extends CoreBaseStrategy<OverlapCheckInput, OverlapCheckResult> {
  static get method(): string {
    return NEW_METHOD_ID_OVERLAP_CHECK;
  }

  async evaluate(
    input: OverlapCheckInput,
    _context: RequestContext,
  ): Promise<StrategyResult<OverlapCheckResult>> {
    if (!input?.chain) {
      throw new Error('OverlapCheckStrategy: requires a `chain` input');
    }
    const { chain, report } = verifyLayout(input.chain, input.emit ?? {});
    const capturedAt = new Date().toISOString();
    const totals: VerifyReport = report;
    const totalSoft = totals.unresolvedSpacing + totals.unresolvedEdge + totals.unresolvedAxis;
    const insights = totals.unresolvedHard > 0
      ? [{
          text: `Hard overlap residuals: ${totals.unresolvedHard} (post-projection — indicates a geometry corner case).`,
          by: NEW_METHOD_ID_OVERLAP_CHECK,
          type: 'other' as const,
        }]
      : totalSoft > 0
        ? [{
            text: `Soft overlap residuals: spacing=${totals.unresolvedSpacing}, edge=${totals.unresolvedEdge}, axis=${totals.unresolvedAxis}.`,
            by: NEW_METHOD_ID_OVERLAP_CHECK,
            type: 'other' as const,
          }]
        : [];
    return {
      signals: [
        { name: 'component-count', value: input.chain.components.length, source: 'computed', capturedAt },
        { name: 'iterations', value: report.iterations, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights,
      result: {
        chain,
        unresolvedHard: report.unresolvedHard,
        unresolvedSpacing: report.unresolvedSpacing,
        unresolvedEdge: report.unresolvedEdge,
        unresolvedAxis: report.unresolvedAxis,
        iterations: report.iterations,
      },
    };
  }
}
