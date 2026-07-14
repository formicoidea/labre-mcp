// Real strategy for `wardley:iteration:purpose:generate:default`
// (ast-schema.md v0.1.0 § iteration/purpose). Replaces the mock.
//
// Formulates a study `Context` (a Wardley "purpose") from a free `topic` +
// `intent`, following the pedagogical framework (Notion — Étape n°1 : le jeu):
// the "présent idéal" (Bloom/Mosior) and the five-part synthesis model —
//   raison d'être → contexte qui légitime → objectif qui en rapproche →
//   objectif concis et tangible → problématisation.
//
// The output Context is the exact input of
// `wardley:iteration:purpose:audit-purpose-quality:default`, so generate emits
// `raisonDetre` + `problematisation` (the two fields the audit needs) on top of
// the ast-schema Context fields.
//
// LLM-backed by nature (it turns a free brief into structured prose). When no
// LLM is available the strategy degrades to a minimal skeleton Context seeded
// from the raw topic, flagged in the insight, so a downstream recipe never
// crashes (feedback: MCP tools always in Degradable).

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { tryDegradeAmbient } from '#lib/degradation/index.mjs';
import { PurposeContextSchema, type PurposeContext } from '#schemas/context.schema.mjs';
import { z } from 'zod';

const METHOD_ID = 'wardley:iteration:purpose:generate:default';

// Free-form brief. Lenient (strips unknown keys) so a caller passing extra
// context never trips the boundary — the strategy's job is to formalise, not
// to reject.
const PurposeGenerateInputSchema = z.object({
  topic: z.string().default(''),
  intent: z.string().default(''),
  // The user's original verbatim prompt, passed through into the output
  // Context (never sent to the LLM as a field to fill). The calling agent is
  // expected to forward the human's request here; absent → empty.
  prompt: z.string().default(''),
});

// The Context fields the LLM is asked to fill. Kept explicit so the parser can
// strip anything else a chatty model returns before strict validation.
const CONTEXT_KEYS = [
  'title',
  'scope',
  'angle',
  'temporality',
  'granularity',
  'deliverables',
  'raisonDetre',
  'problematisation',
] as const;

/** Extract the first balanced JSON object from a raw LLM response. */
function extractJson(response: string): string {
  const start = response.indexOf('{');
  const end = response.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parsePurposeContext: no JSON object found in LLM response');
  }
  return response.slice(start, end + 1);
}

// Registered parser (prompts.config.json → "purpose-generate"). Keeps only the
// known Context keys, then validates through the strict schema (which fills
// defaults for anything the LLM omitted, so a partial answer still yields a
// well-typed Context).
export function parsePurposeContextResponse(response: string): PurposeContext {
  const raw = JSON.parse(extractJson(response)) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of CONTEXT_KEYS) {
    if (k in raw) picked[k] = raw[k];
  }
  return PurposeContextSchema.parse(picked);
}

export class WardleyIterationPurposeGenerateDefaultStrategy extends BaseStrategy<unknown, PurposeContext> {
  private readonly _llmCall: LLMCall | null;

  constructor(options: { llmCall?: LLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(input: unknown, _context: RequestContext): Promise<StrategyResult<PurposeContext>> {
    const capturedAt = new Date().toISOString();

    const parsedIn = PurposeGenerateInputSchema.safeParse(input ?? {});
    const { topic, intent, prompt } = parsedIn.success
      ? parsedIn.data
      : { topic: '', intent: '', prompt: '' };

    // Resolve the LLM defensively: an unconfigured id or any registry error
    // degrades to the skeleton Context rather than throwing.
    let llmCall = this._llmCall;
    if (!llmCall) {
      try {
        llmCall = getStrategyLLM('purpose-generate');
      } catch {
        llmCall = null;
      }
    }

    let context: PurposeContext | null = null;
    if (llmCall) {
      const call = llmCall;
      const p = getPrompt('purpose-generate', 'default');
      const built = p.build({ topic, intent });
      const response = await tryDegradeAmbient<string | null>(
        'llm:purpose-generate',
        () => call(built.user, undefined, { systemPrompt: built.system }),
        null,
      );
      if (response != null) {
        try {
          context = p.parse(response) as PurposeContext;
        } catch {
          context = null; // malformed LLM JSON → skeleton fallback below
        }
      }
    }

    const degraded = context === null;
    // Skeleton fallback: seed the objective title from the raw topic so a
    // downstream step still has something to key on; the audit will (rightly)
    // flag the missing raison d'être / problématisation.
    // The user's original prompt is unstructured passthrough — it is never LLM-
    // generated (not in CONTEXT_KEYS), so it is stamped onto the result here.
    const result: PurposeContext = {
      ...(context ?? PurposeContextSchema.parse({ title: topic })),
      prompt,
    };

    const insights: StrategyResult['insights'] = degraded
      ? [{ text: 'purpose-generate: LLM indisponible — Context minimal seedé depuis le topic.', by: METHOD_ID, type: 'other' }]
      : [{ text: `Purpose formulé : « ${result.title || '(sans titre)'} ».`, by: METHOD_ID, type: 'other' }];

    return {
      signals: [
        { name: 'topic', value: topic, source: 'user-input', capturedAt },
        { name: 'llm-used', value: !degraded, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights,
      result,
    };
  }
}
