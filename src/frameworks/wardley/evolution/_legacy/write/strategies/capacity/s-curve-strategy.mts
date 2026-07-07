// S-curve strategy: wraps the dual generalized sigmoid model
// (certitude, ubiquity) → evolution via geometric projection onto the center curve.
// This is the primary deterministic/analytical capacity strategy.
//
// Implements the core BaseStrategy contract with methodId
// `wardley:map:climate:position-functional-in-evolution:s-curve`. Registered in the core
// StrategyRegistry via `frameworks/wardley/evolution/registry.mts`.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { ComponentInput, EvolutionResult } from '#types/evolution.mjs';
import { computeEvolution } from '../../s-curve/s-curve.mjs';

const NEW_METHOD_ID = 'wardley:map:climate:position-functional-in-evolution:s-curve';

// any: matches the inferred return type of `computeEvolution` — kept open
// because the s-curve module does not export it
function computeConfidence(sc: { zone: string; distToCenter: number }): number {
  let confidence: number;
  if (sc.zone === 'competitive') {
    confidence = 0.9;
  } else {
    // Outside band: logarithmic decay from 0.90, using Euclidean distance to center sigmoid
    const k = 2.0;
    const scale = 0.2;
    confidence = Math.max(0.05, 0.9 / (1 + k * Math.log(1 + sc.distToCenter / scale)));
  }
  return Math.round(confidence * 1000) / 1000;
}

function requireInputs(component: ComponentInput): { certitude: number; ubiquity: number } {
  const { certitude, ubiquity } = component;
  if (certitude == null || ubiquity == null) {
    throw new Error('SCurveStrategy requires certitude and ubiquity inputs');
  }
  return { certitude, ubiquity };
}

export class SCurveStrategy extends CoreBaseStrategy<ComponentInput, EvolutionResult> {
  static get method(): string {
    return NEW_METHOD_ID;
  }

  async evaluate(
    component: ComponentInput,
    _context: RequestContext,
  ): Promise<StrategyResult<EvolutionResult>> {
    const { certitude, ubiquity } = requireInputs(component);
    const sc = computeEvolution(certitude, ubiquity);
    const confidence = computeConfidence(sc);

    const capturedAt = new Date().toISOString();
    return {
      signals: [
        { name: 'certitude', value: certitude, source: 'user-input', capturedAt },
        { name: 'ubiquity', value: ubiquity, source: 'user-input', capturedAt },
        // Emit confidence as a numeric signal so the run-level quality map (CP10)
        // can forward it to telemetry. It already lives in `result.confidence`;
        // this mirrors it into `signals` where the runner harvests numeric metrics.
        { name: 'confidence', value: confidence, source: 'computed', capturedAt },
      ],
      // s-curve is deterministic — no LLM reasoning to capture (ARCH-22 progressive)
      reasoning: [],
      insights: [],
      result: {
        evolution: sc.evolution,
        confidence,
        method: NEW_METHOD_ID,
      },
    };
  }
}

