// S-curve strategy: wraps the existing dual generalized sigmoid model
// (certitude, ubiquity) → evolution via geometric projection onto the center curve
//
// This is the primary deterministic/analytical strategy.
// Requires: certitude, ubiquity inputs on the component.

import { BaseStrategy } from './base-strategy.mjs';
import {
  computeEvolution,
  isInBand,
  bandDistance,
  DEFAULT_PARAMS,
} from '../s-curve.mjs';

export class SCurveStrategy extends BaseStrategy {

  static get method() {
    return 's-curve';
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {import('./base-strategy.mjs').EvolutionResult}
   */
  evaluate(component) {
    const { certitude, ubiquity } = component;

    if (certitude == null || ubiquity == null) {
      throw new Error('SCurveStrategy requires certitude and ubiquity inputs');
    }

    const result = computeEvolution(certitude, ubiquity);

    // Confidence is based on how deep inside the band the point sits.
    // Points inside the band get high confidence; outside gets lower confidence
    // scaled by how far they are from the boundary.
    const inBand = isInBand(certitude, ubiquity);
    const bd = Math.abs(bandDistance(certitude, ubiquity));

    let confidence;
    if (inBand) {
      // Inside band: confidence 0.7–1.0 based on distance from boundary
      // (deeper inside = higher confidence)
      confidence = Math.min(1, 0.7 + bd * 0.6);
    } else {
      // Outside band: confidence 0.2–0.5 inversely proportional to distance
      confidence = Math.max(0.2, 0.5 - bd * 0.3);
    }
    confidence = Math.round(confidence * 1000) / 1000;

    const validated = BaseStrategy.validateResult({
      evolution: result.evolution,
      confidence,
      method: SCurveStrategy.method,
    });

    return validated;
  }
}
