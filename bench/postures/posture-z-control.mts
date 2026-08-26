// Posture Z — THE CONTROL. No LLM at all.
//
// The geometry CLI's positional prior, answered raw. It costs nothing, it calls
// nothing, and it exists so the three measured rates can be read: a rate that
// does not beat this line was not produced by the model's knowledge of the
// component, only by the shape of the map (and, on a corpus where most
// components sit in one stage, by the base rate).
//
// It is a control, not a candidate posture. It is never counted in the LLM
// budget, and it is not one of the three arms of the falsification test.

import type { GoldCase, Posture, PostureAnswer, PostureDeps } from '../bench.types.mjs';
import { computeChainGeometry } from '../geometry/chain-geometry.mjs';

export const postureZ: Posture = {
  id: 'Z',
  label: 'Témoin — prior géométrique seul, aucun LLM',
  llmCallsPerCase: 0,

  async run(goldCase: GoldCase, deps: PostureDeps): Promise<PostureAnswer> {
    const map = deps.goldSet.maps[goldCase.mapKey];
    if (!map) throw new Error(`gold set has no map "${goldCase.mapKey}"`);
    const geometry = computeChainGeometry(map, goldCase.componentId);

    return {
      evolution: geometry.prior.center,
      // Fixed and low: the prior knows nothing about the component itself.
      confidence: 0.3,
      rationale: geometry.notes.join('\n'),
      trace: {
        llmCalls: [],
        structured: { prior: geometry.prior, positional: true },
        deterministic: { tool: 'bench/geometry/chain-geometry.mts', geometry },
      },
    };
  },
};
