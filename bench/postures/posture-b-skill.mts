// Posture B — THE BARE MARKDOWN SKILL.
//
// The same model, the same case payload, and the method in prose
// (`bench/skill/place-component.skill.md`) as the system prompt. No registry,
// no strategy, no typed input, no tool. One call, one answer.
//
// The skill file is deliberately RICHER than the engine's own system prompt: it
// spells out the four stages, the evidence order and the traps. A falsification
// test that handicaps the challenger proves nothing, so the challenger gets the
// method written as well as we can write it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldCase, Posture, PostureAnswer, PostureDeps } from '../bench.types.mjs';
import { parseEvolutionAnswer, renderCasePayload } from './answer-format.mjs';

const benchDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The prose method, read once. */
export function loadSkill(): string {
  return readFileSync(path.join(benchDir, 'skill', 'place-component.skill.md'), 'utf8');
}

export const postureB: Posture = {
  id: 'B',
  label: 'Skill Markdown nue — même modèle, aucun outillage',
  llmCallsPerCase: 1,

  async run(goldCase: GoldCase, deps: PostureDeps): Promise<PostureAnswer> {
    const system = loadSkill();
    const user = renderCasePayload(goldCase);
    const response = await deps.llmCall(user, undefined, { systemPrompt: system });
    const parsed = parseEvolutionAnswer(response);

    return {
      evolution: parsed.evolution,
      confidence: parsed.confidence,
      rationale: response,
      trace: {
        llmCalls: [],
        // Nothing structured: the whole "why" is prose the model chose to
        // write, in a shape nothing downstream can read. That IS the finding.
        structured: null,
        deterministic: null,
      },
    };
  },
};
