// Real strategy `render:wardley-map:text:lint:default`.
//
// LLM "linter" for NEAR-STRUCTURED value-chain text: an almost-valid OWM DSL,
// an indented/bulleted component list, or an approximate JSON map. It
// normalises the source into the requested target — canonical JSON (lossless,
// DEFAULT: colors, evolvesTo, inertia, pipelines, method, context and custom
// phase nomenclature via the input-shape renderConfig) or OWM DSL (editable,
// documented losses) — and NEVER produces the canonical map from prose on its
// own authority:
//
//   - target json: schema-constrained generation (`structured` capability)
//     when the provider supports it, plain text otherwise; either way the
//     deterministic WardleyMapSchema gate has the final word;
//   - target owm: the linted `dsl` goes to the deterministic `owm:parse:dsl`
//     (which also captures `// key: value` study-context headers).
//
// So the AI layer is cosmetic by design (recipe `render:map:text-to-canonical`
// chains lint → parse:dsl); the deterministic layer stays the only producer
// of a canonical WardleyMap. Free prose is OUT of scope: the prompt refuses
// with NOT_A_VALUE_CHAIN (generation from a brief is value-chain:generate's
// job, not a linter's).
//
// Deterministic short-circuits (no LLM call at all):
//   - input already parses as canonical JSON → returned as such;
//   - input already parses as clean OWM DSL (zero parser errors, at least one
//     element) → returned verbatim.
//
// Degradation-first: no LLM configured, a refusal, or a lint that still fails
// the deterministic gates all end as `linted: false` + warnings — never a throw.

import { z } from 'zod';
import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { readRenderConfig, withoutRenderConfig } from '#schemas/render-config-passthrough.mjs';
import type { LLMCall, StructuredLLMCall } from '#types/llm.mjs';
import { getStrategyLLM, getStrategyStructuredLLM } from '#lib/llm/registry.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { tryDegradeAmbient } from '#lib/degradation/index.mjs';
import { parse as parseOwm } from '#lib/vendor/cli-owm/index.mjs';

const METHOD_ID = 'render:wardley-map:text:lint:default';

/** Key under which the prompt pair and the LLM route are declared
 *  (prompts.config.json / llm.config.json). */
const PROMPT_ID = 'render-text-lint';

/** Max characters of raw model output kept as a reasoning trace. */
const REASONING_TRACE_LIMIT = 4000;

/** The prompt's refusal token for input that is not a value chain at all. */
const REFUSAL = 'NOT_A_VALUE_CHAIN';

const InputSchema = z.object({
  text: z.string().min(1),
  /** Output target: canonical JSON (lossless, default) or OWM DSL (editable). */
  target: z.enum(['json', 'owm']).default('json'),
});

/** Structured-output envelope: the model must keep the ability to REFUSE a
 *  source that is not a value chain — a bare map schema would force it to
 *  invent one. `refused: true` (map null) is the structured twin of the text
 *  path's NOT_A_VALUE_CHAIN token. */
const StructuredLintSchema = z.object({
  refused: z.boolean().default(false),
  map: WardleyMapSchema.nullable(),
});

/** JSON Schema of the envelope above, for schema-constrained generation on
 *  providers that support the `structured` capability. Computed lazily once.
 *  Best-effort constraint only (z.toJSONSchema leaves transformed scalars
 *  open): the deterministic gate below always has the final word. */
let structuredLintJsonSchema: Record<string, unknown> | null = null;
function getStructuredLintJsonSchema(): Record<string, unknown> {
  if (structuredLintJsonSchema === null) {
    structuredLintJsonSchema = z.toJSONSchema(StructuredLintSchema, {
      unrepresentable: 'any',
    }) as Record<string, unknown>;
  }
  return structuredLintJsonSchema;
}

/** The lint markers must never be steerable from the linted document itself:
 *  the delimited parser takes the FIRST block, so a marker smuggled into the
 *  source would hijack the output. Neutralise them before interpolation. */
function sanitizeSource(text: string): string {
  return text.replace(/LINT_(START|END)/g, 'LINT-$1');
}

export interface RenderWardleyMapTextLintResult {
  /** Format the source normalised into, or null when linting failed. */
  format: 'owm' | 'json' | null;
  /** Valid OWM DSL (owm path) — feed it to `owm:parse:dsl`. */
  dsl: string | null;
  /** Canonical map (json path) — already schema-validated, nothing left to parse. */
  map: WardleyMap | null;
  linted: boolean;
  llmUsed: boolean;
  warnings: string[];
}

/** Deterministic gate for the JSON path: value → canonical map, with the
 *  input-shape renderConfig re-attached (passthrough idiom — the parsed shape
 *  is not re-parsable, so the map never carries the resolved form). */
function gateCanonicalValue(parsed: unknown, warnings: string[]): WardleyMap | null {
  const validated = WardleyMapSchema.safeParse(withoutRenderConfig(parsed));
  if (!validated.success) return null;
  const rc = readRenderConfig(parsed);
  if (rc === undefined) return validated.data;
  // The renderConfig itself must also be schema-valid to be kept.
  if (WardleyMapSchema.safeParse(parsed).success) {
    return { ...validated.data, renderConfig: rc } as WardleyMap;
  }
  warnings.push('renderConfig rejected by the canonical schema; dropped from the linted map');
  return validated.data;
}

/** Deterministic gate for the JSON path: syntax + canonical schema. */
function tryCanonicalJson(text: string, warnings: string[] = []): WardleyMap | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  // any: JSON.parse's natural return type; narrowed by the schema right after.
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return gateCanonicalValue(parsed, warnings);
}

/** Deterministic gate for the OWM path: the vendored parser accepts every line
 *  and finds at least one element (the parser is lenient, so zero elements or
 *  any rejected line means "this is not clean DSL"). */
function isCleanOwmDsl(text: string): boolean {
  try {
    const owm = parseOwm(text);
    return owm.errors.length === 0 && owm.components.length + owm.anchors.length > 0;
  } catch {
    return false;
  }
}

export class RenderWardleyMapTextLintStrategy extends BaseStrategy<
  // any-adjacent: input is validated by InputSchema below (upstream may be a mock).
  unknown,
  RenderWardleyMapTextLintResult
> {
  private readonly _llmCall: LLMCall | null;
  private readonly _structuredLlmCall: StructuredLLMCall | null;

  /** `llmCall`/`structuredLlmCall` are the test/eval injection seams. */
  constructor(options: { llmCall?: LLMCall; structuredLlmCall?: StructuredLLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
    this._structuredLlmCall = options.structuredLlmCall ?? null;
  }

  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<RenderWardleyMapTextLintResult>> {
    const capturedAt = new Date().toISOString();
    const validated = InputSchema.safeParse(input);

    if (!validated.success) {
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: 'cannot lint: input does not carry a non-empty `text` string (upstream step not yet promoted?)',
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: { format: null, dsl: null, map: null, linted: false, llmUsed: false, warnings: ['input is not { text: string }'] },
      };
    }

    const { text, target } = validated.data;
    const warnings: string[] = [];
    const reasoning: StrategyResult<RenderWardleyMapTextLintResult>['reasoning'] = [];

    // ── Deterministic short-circuits (target only steers the LLM path) ────
    const directMap = tryCanonicalJson(text, warnings);
    if (directMap !== null) {
      return this._done(capturedAt, reasoning, warnings, {
        format: 'json', dsl: null, map: directMap, linted: true, llmUsed: false, warnings,
      });
    }
    if (isCleanOwmDsl(text)) {
      return this._done(capturedAt, reasoning, warnings, {
        format: 'owm', dsl: text, map: null, linted: true, llmUsed: false, warnings,
      });
    }

    let format: RenderWardleyMapTextLintResult['format'] = null;
    let dsl: string | null = null;
    let map: WardleyMap | null = null;
    let llmUsed = false;

    // ── Schema-constrained lint (target json, providers with `structured`) ─
    // The provider enforces the canonical JSON Schema at generation time;
    // the deterministic gate below still has the final word.
    let structuredCall: StructuredLLMCall | null = null;
    if (target === 'json') {
      if (this._structuredLlmCall !== null) {
        structuredCall = this._structuredLlmCall;
      } else if (this._llmCall === null) {
        try {
          structuredCall = getStrategyStructuredLLM(PROMPT_ID, getStructuredLintJsonSchema());
        } catch (err) {
          // Expected on providers without the capability (http-api) — fall back
          // to the text path, but say so instead of swallowing the reason.
          structuredCall = null;
          warnings.push(`structured output unavailable (${(err as Error).message}); text lint fallback`);
        }
      }
    }

    if (structuredCall !== null) {
      llmUsed = true;
      const call = structuredCall;
      const prompt = getPrompt(PROMPT_ID);
      const built = prompt.build({ text: sanitizeSource(text), target });
      const value = await tryDegradeAmbient<unknown>(
        `llm:${PROMPT_ID}`,
        () => call(built.user, undefined, { systemPrompt: built.system }),
        null,
      );
      if (value === null) {
        warnings.push('structured lint LLM call failed or returned nothing');
      } else {
        const envelope = StructuredLintSchema.pick({ refused: true }).safeParse(value);
        const refused = envelope.success && envelope.data.refused === true;
        const rawMap = value && typeof value === 'object' ? (value as { map?: unknown }).map : undefined;
        if (refused) {
          warnings.push('the linter refused: the source is not a value chain (free prose is value-chain:generate territory)');
        } else if (rawMap === null || rawMap === undefined) {
          warnings.push('structured lint returned neither a refusal nor a map');
        } else {
          map = gateCanonicalValue(rawMap, warnings);
          if (map !== null) {
            format = 'json';
          } else {
            warnings.push('structured lint output still fails the canonical WardleyMap schema');
          }
        }
      }
    } else {
      // ── Text lint (target owm, injected seam, or no structured support) ─
      let llmCall = this._llmCall;
      if (llmCall === null) {
        try {
          llmCall = getStrategyLLM(PROMPT_ID);
        } catch (err) {
          warnings.push(`no LLM available for linting: ${(err as Error).message}`);
        }
      }

      if (llmCall !== null) {
        llmUsed = true;
        const call = llmCall;
        const prompt = getPrompt(PROMPT_ID);
        const built = prompt.build({ text: sanitizeSource(text), target });

        const response = await tryDegradeAmbient<string | null>(
          `llm:${PROMPT_ID}`,
          () => call(built.user, undefined, { systemPrompt: built.system }),
          null,
        );

        if (response === null) {
          warnings.push('lint LLM call failed or returned nothing');
        } else {
          reasoning.push({ by: METHOD_ID, text: response.slice(0, REASONING_TRACE_LIMIT) });
          let payload: string = response;
          try {
            const block = prompt.parse(response) as string | null;
            if (typeof block === 'string' && block.length > 0) payload = block;
          } catch {
            // Parser resolution problem — fall through to the raw response.
          }
          payload = payload.trim();

          // Exact match only: a payload that merely CONTAINS the token
          // somewhere (e.g. quoted inside a linted document) is not a refusal.
          if (payload === REFUSAL) {
            warnings.push('the linter refused: the source is not a value chain (free prose is value-chain:generate territory)');
          } else if (payload.startsWith('{')) {
            map = tryCanonicalJson(payload, warnings);
            if (map !== null) {
              format = 'json';
            } else {
              warnings.push('linted JSON still fails the canonical WardleyMap schema');
            }
          } else if (isCleanOwmDsl(payload)) {
            format = 'owm';
            dsl = payload;
          } else {
            warnings.push('linted DSL is still rejected by the OWM parser');
          }
        }
      }
    }

    return this._done(capturedAt, reasoning, warnings, {
      format, dsl, map, linted: format !== null, llmUsed, warnings,
    });
  }

  private _done(
    capturedAt: string,
    reasoning: StrategyResult<RenderWardleyMapTextLintResult>['reasoning'],
    warnings: string[],
    result: RenderWardleyMapTextLintResult,
  ): StrategyResult<RenderWardleyMapTextLintResult> {
    const insights: StrategyResult<RenderWardleyMapTextLintResult>['insights'] = [];
    if (!result.linted) {
      insights.push({
        text: `cannot lint the source: ${warnings.join('; ') || 'unknown reason'}`,
        by: METHOD_ID,
        type: 'other',
      });
    } else if (result.llmUsed) {
      insights.push({
        text:
          `Source normalised to ${result.format === 'owm' ? 'OWM DSL' : 'canonical JSON'} by the lint LLM. ` +
          'Positions not stated in the source are readability layout, not evolution estimates — ' +
          'run the climate positioning strategies before reading maturity off this map.',
        by: METHOD_ID,
        type: 'other',
      });
    }
    return {
      signals: [
        { name: 'input-valid', value: true, source: 'computed', capturedAt },
        { name: 'llm-used', value: result.llmUsed, source: 'computed', capturedAt },
        { name: 'linted', value: result.linted, source: 'computed', capturedAt },
        { name: 'format', value: result.format ?? 'none', source: 'computed', capturedAt },
      ],
      reasoning,
      insights,
      result,
    };
  }
}
