// Step 1 of the write:chain:* pipeline — LLM #1.
//
// Extracts structured metadata (angle, scope, objective, imperatives,
// temporality, contextSummary) from a natural-language command. The parser
// is exported separately so it can be registered against the `write-chain /
// extract-metadata` prompt in src/lib/prompts/init.mjs.

import { parseKeyValueBlock } from '#lib/prompts/parsers.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { tryDegradeAmbient } from '#lib/degradation/index.mjs';
import type { ChainMetadata, Temporality } from '#types/value-chain.mjs';

const TEMPORALITY_VALUES: ReadonlySet<Temporality> = new Set<Temporality>(['past', 'present', 'future']);

/**
 * Parse the six-line `key=value` block produced by the extract-metadata
 * prompt. `angle` and `scope` are mandatory — throw if missing. Everything
 * else has a neutral default so the downstream pipeline can proceed even
 * when the LLM omits secondary fields.
 */
export function parseChainMetadataResponse(text: string): ChainMetadata {
  const raw = parseKeyValueBlock(
    text,
    ['title', 'angle', 'scope', 'objective', 'imperatives', 'temporality', 'contextSummary'],
  );

  if (!raw.title || !raw.angle || !raw.scope) {
    throw new Error(
      `extractChainMetadata: missing mandatory fields (title, angle, scope) in LLM response: ${text.slice(0, 200)}`,
    );
  }

  const temporalityRaw = (raw.temporality ?? 'present').trim().toLowerCase();
  const temporality: Temporality = TEMPORALITY_VALUES.has(temporalityRaw as Temporality)
    ? (temporalityRaw as Temporality)
    : 'present';

  // The prompt requires `imperatives=none` as the sentinel for "no imperatives"
  // so the key=value block never leaves an empty value (which would cause
  // parseKeyValueBlock to bleed into the next line since its separator regex
  // includes newline whitespace).
  const impRaw = (raw.imperatives ?? '').trim();
  const imperatives = impRaw === '' || impRaw.toLowerCase() === 'none'
    ? []
    : impRaw.split(';').map(s => s.trim()).filter(s => s.length > 0);

  return {
    title: raw.title!.trim(),
    angle: raw.angle.trim(),
    scope: raw.scope.trim(),
    objective: (raw.objective ?? '').trim(),
    imperatives,
    temporality,
    contextSummary: (raw.contextSummary ?? '').trim(),
  };
}

// any: llmCall closure shape is provider-dependent (see src/lib/llm)
type LlmCall = any;

/**
 * Invoke LLM #1 to extract structured metadata from the raw command. Wraps
 * the call in `tryDegradeAmbient` so an LLM failure surfaces on the
 * ambient collector rather than crashing the pipeline.
 */
export async function extractMetadata(
  nlCommand: string,
  llmCall: LlmCall,
): Promise<ChainMetadata> {
  const p = getPrompt('write-chain', 'extract-metadata');
  const built = p.build({ nlCommand });

  const response = await tryDegradeAmbient<string | null>(
    'llm:write-chain:extract-metadata',
    () => llmCall(built.user, undefined, { systemPrompt: built.system }),
    null,
  );

  if (response == null) {
    throw new Error('extractMetadata: LLM call degraded (see ambient collector)');
  }

  return p.parse(response);
}
