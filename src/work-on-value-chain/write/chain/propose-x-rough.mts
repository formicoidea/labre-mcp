// Step 3 of the write:chain:* pipeline — LLM #3.
//
// Asks the LLM to propose a ROUGH X coordinate per component for visual
// CLARITY of the chain. NOT an evolution-maturity estimate — the evolution
// axis is hidden at this stage of the Wardley study cycle and is revealed
// only by `estimateEvolution` (phase 3).
//
// Runs in parallel with `compute-visibility` (X and Y are independent at
// this step). Output is a `RawValueChain` enriched with `xHint` per
// component when the LLM provided a valid value; missing or invalid
// xHints are left undefined and `adjust-x` falls back to a uniform
// per-Y-level spread.

import { z } from 'zod';
import { getPrompt } from '../../../lib/prompts/registry.mjs';
import { tryDegradeAmbient, getCurrentCollector } from '../../../lib/degradation/index.mjs';
import type { RawValueChain, ValueChainComponent } from '../../../types/value-chain.mjs';

const PositionSchema = z.object({
  name: z.string().min(1),
  xHint: z.number().min(0).max(1),
}).strict();

const ProposeXResponseSchema = z.object({
  positions: z.array(PositionSchema).default([]),
}).strict();

function extractJsonPayload(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `proposeXRough: no JSON object found in LLM response: ${text.slice(0, 200)}`,
    );
  }
  return text.slice(start, end + 1);
}

function warn(source: string, message: string): void {
  const collector = getCurrentCollector();
  if (collector) {
    collector.recordError(source, new Error(message), { recoverable: true, severity: 'warning' });
  }
}

/**
 * Parse the LLM #3 response into a Map<componentName, xHint>. Strict Zod
 * shape; out-of-range numbers are rejected (the schema clamps them out
 * via z.number().min(0).max(1)). Duplicate names are recorded as warnings
 * on the ambient collector and only the first occurrence is kept.
 */
export function parseProposeXRoughResponse(text: string): Map<string, number> {
  const payload = extractJsonPayload(text);
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch (err) {
    throw new Error(`proposeXRough: invalid JSON in LLM response: ${(err as Error).message}`);
  }
  const parsed = ProposeXResponseSchema.parse(data);

  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const p of parsed.positions) {
    if (seen.has(p.name)) {
      warn('llm:write-chain:propose-x-rough', `duplicate xHint for "${p.name}" — first wins`);
      continue;
    }
    seen.add(p.name);
    out.set(p.name, p.xHint);
  }
  return out;
}

// any: llmCall closure shape is provider-dependent (see src/lib/llm)
type LlmCall = any;

/**
 * Invoke LLM #3 to propose a rough X for each component. Returns the
 * `RawValueChain` enriched with `xHint`. Components for which the LLM
 * returned no valid hint keep `xHint === undefined`; `adjust-x` falls
 * back to a uniform per-Y-level spread for those.
 *
 * On full LLM degradation (no response), every xHint is left undefined.
 */
export async function proposeXRough(
  raw: RawValueChain,
  llmCall: LlmCall,
): Promise<RawValueChain> {
  const p = getPrompt('write-chain', 'propose-x-rough');
  const componentsForPrompt = raw.components.map(c => ({
    name: c.name,
    role: c.role,
    description: c.description ?? '',
    context: c.context ?? '',
  }));
  const built = p.build({
    components: JSON.stringify(componentsForPrompt),
    links: JSON.stringify(raw.links),
    anchorContext: JSON.stringify({
      title: raw.metadata.title,
      angle: raw.metadata.angle,
      scope: raw.metadata.scope,
    }),
  });

  const response = await tryDegradeAmbient<string | null>(
    'llm:write-chain:propose-x-rough',
    () => llmCall(built.user, undefined, { systemPrompt: built.system }),
    null,
  );

  if (response == null) {
    warn(
      'llm:write-chain:propose-x-rough',
      'LLM call degraded — xHints unset, adjust-x will fall back',
    );
    return raw;
  }

  const xByName = p.parse(response) as Map<string, number>;

  const enriched: ValueChainComponent[] = raw.components.map(c => {
    const hint = xByName.get(c.name);
    if (hint === undefined) {
      warn(
        'llm:write-chain:propose-x-rough',
        `no xHint returned for "${c.name}" — adjust-x will fall back`,
      );
      return c;
    }
    return { ...c, xHint: hint };
  });

  return {
    metadata: raw.metadata,
    components: enriched,
    links: raw.links,
  };
}
