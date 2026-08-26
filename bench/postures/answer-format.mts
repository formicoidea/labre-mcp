// The answer contract shared by every posture.
//
// Parsing is factored here on purpose: a difference in how two arms are READ
// would be a difference in their measured score that has nothing to do with the
// arms themselves. The engine (posture A) parses inside its own strategy, with
// the same parser (`parseKeyValueBlock`) and the same clamp/round — the shape
// below mirrors it deliberately, it does not re-invent it.

import { parseKeyValueBlock } from '#lib/prompts/parsers.mjs';
import type { GoldCase } from '../bench.types.mjs';

export interface ParsedAnswer {
  evolution: number;
  confidence: number;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Read `evolution=` / `confidence=` out of a free-text answer, then clamp and
 * round exactly as `LLMDirectStrategy` does. Throws when no evolution is
 * present — a posture that cannot be read scores as a failure, never as 0.
 */
export function parseEvolutionAnswer(text: string): ParsedAnswer {
  const raw = parseKeyValueBlock(text, ['evolution', 'confidence'], {
    separator: 'any',
    anchored: false,
  });
  if (raw.evolution === undefined) {
    throw new Error(`no "evolution=" line in the answer: ${text.slice(0, 200)}`);
  }
  const evolution = Number.parseFloat(raw.evolution);
  if (!Number.isFinite(evolution)) {
    throw new Error(`unreadable evolution value "${raw.evolution}"`);
  }
  const confidence =
    raw.confidence === undefined ? 0.6 : Number.parseFloat(raw.confidence);
  return {
    evolution: round3(Math.max(0, Math.min(1, evolution))),
    confidence: round3(Math.max(0.1, Math.min(1, Number.isFinite(confidence) ? confidence : 0.6))),
  };
}

/**
 * The case payload, rendered exactly as the engine's own user prompt renders it
 * (`prompts/historical-evolution.without-capability.user.md`). Input parity
 * between the arms is the validity condition of the whole bench, so the
 * challengers read the case through the incumbent's own template.
 */
export function renderCasePayload(goldCase: GoldCase): string {
  return [
    `Component: ${goldCase.component}`,
    `Description: ${goldCase.description}`,
    `Context: ${goldCase.context}`,
    `Context date: ${goldCase.date}`,
  ].join('\n');
}
