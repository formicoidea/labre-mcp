// S-curve strategy: wraps the existing dual generalized sigmoid model
// (certitude, ubiquity) → evolution via geometric projection onto the center curve
//
// This is the primary deterministic/analytical strategy.
// Requires: certitude, ubiquity inputs on the component.

import { BaseStrategy } from './base-strategy.mjs';
import { computeEvolution } from '../../evolution/s-curve.mjs';

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

    // Confidence: constant inside band, logarithmic decay outside.
    // Discontinuous gap at boundary signals clearly that the point left the valid zone.
    // Distance is Euclidean to the center sigmoid (not vertical to band edge).
    let confidence;
    if (result.zone === 'competitive') {
      confidence = 0.9;
    } else {
      // Outside band: logarithmic decay from 0.90 (continuous), using Euclidean distance to center sigmoid
      const k = 2.0;
      const scale = 0.2;
      confidence = Math.max(0.05, 0.9 / (1 + k * Math.log(1 + result.distToCenter / scale)));
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
