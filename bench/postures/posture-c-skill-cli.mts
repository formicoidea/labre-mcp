// Posture C — THE MARKDOWN SKILL + THE GEOMETRY CLI.
//
// Exactly posture B, plus the output of one deterministic tool
// (`bench/geometry/chain-geometry.mts`) appended to the case payload, and one
// addendum page telling the model what the tool is and how much to trust it.
// One single variable separates B from C: the tool. That is what makes the
// difference between their scores readable.
//
// The tool runs BEFORE the call and its output is injected as text: the arms
// stay at one LLM call each, so the three rates are comparable at equal cost.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldCase, Posture, PostureAnswer, PostureDeps } from '../bench.types.mjs';
import { computeChainGeometry, formatChainGeometry } from '../geometry/chain-geometry.mjs';
import { parseEvolutionAnswer, renderCasePayload } from './answer-format.mjs';
import { loadSkill } from './posture-b-skill.mjs';

const benchDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadGeometryAddendum(): string {
  return readFileSync(path.join(benchDir, 'skill', 'geometry-tool.addendum.md'), 'utf8');
}

export const postureC: Posture = {
  id: 'C',
  label: 'Skill Markdown + CLI géométrique déterministe',
  llmCallsPerCase: 1,

  async run(goldCase: GoldCase, deps: PostureDeps): Promise<PostureAnswer> {
    const map = deps.goldSet.maps[goldCase.mapKey];
    if (!map) throw new Error(`gold set has no map "${goldCase.mapKey}"`);
    const geometry = computeChainGeometry(map, goldCase.componentId);

    const system = `${loadSkill()}\n\n---\n\n${loadGeometryAddendum()}`;
    const user = [
      renderCasePayload(goldCase),
      '',
      `Chain geometry for "${geometry.label}" on the map "${map.title}":`,
      formatChainGeometry(geometry),
    ].join('\n');

    const response = await deps.llmCall(user, undefined, { systemPrompt: system });
    const parsed = parseEvolutionAnswer(response);

    return {
      evolution: parsed.evolution,
      confidence: parsed.confidence,
      rationale: response,
      trace: {
        llmCalls: [],
        // Still no structured rationale from the model — but half the input is
        // now a fact table anyone can recompute offline, which is a different
        // kind of traceability from prose.
        structured: null,
        deterministic: { tool: 'bench/geometry/chain-geometry.mts', geometry },
      },
    };
  },
};
