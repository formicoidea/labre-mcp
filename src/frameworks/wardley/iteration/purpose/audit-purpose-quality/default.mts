// Real strategy for `wardley:iteration:purpose:audit-purpose-quality:default`
// (ast-schema.md v0.1.0 § iteration/purpose). Replaces the mock.
//
// Audits the quality of a study `Context` (a Wardley "purpose") along six
// dimensions grounded in the pedagogical framework (Notion — Étape n°1 : le
// jeu, "présent idéal" de Bloom/Mosior, chaîne des besoins de Wardley). A good
// purpose is a coherent chain: raison d'être → contexte qui légitime →
// objectif qui rapproche de la raison d'être → objectif concis et tangible →
// problématisation.
//
// Hybrid approach: deterministic checks catch the structural failures for free
// (missing field, malformed problématisation, over-long objective); a single
// LLM pass judges the semantic dimensions (anchoring quality, legitimation,
// coherence, granularity, tangibility). Output is `Insight[]` — one insight per
// dimension. The strategy degrades to deterministic-only insights when no LLM
// is available (feedback: MCP tools always in Degradable).

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { tryDegradeAmbient } from '#lib/degradation/index.mjs';
import { PurposeContextSchema, type PurposeContext } from '#schemas/context.schema.mjs';
import { z } from 'zod';

const METHOD_ID = 'wardley:iteration:purpose:audit-purpose-quality:default';

// ─── Dimensions ─────────────────────────────────────────────────────────────

export type DimensionVerdict = 'pass' | 'warn' | 'fail';

export interface DimensionResult {
  id: string;
  label: string;
  verdict: DimensionVerdict;
  rationale: string;
}

// The six quality dimensions, in report order. Ids are the contract the LLM
// answers against; labels are human-facing (French, the study language).
export const PURPOSE_AUDIT_DIMENSIONS = [
  { id: 'anchor-raison-detre',   label: "Ancrage raison d'être" },
  { id: 'context-legitimation',  label: 'Légitimation par le contexte' },
  { id: 'objective-coherence',   label: "Cohérence objectif ↔ raison d'être" },
  { id: 'right-granularity',     label: 'Bon grain (objectif intermédiaire)' },
  { id: 'concision-tangibility', label: 'Concision & tangibilité' },
  { id: 'problematisation',      label: 'Problématisation' },
] as const;

export type DimensionId = (typeof PURPOSE_AUDIT_DIMENSIONS)[number]['id'];

const LABEL_BY_ID = new Map<string, string>(PURPOSE_AUDIT_DIMENSIONS.map((d) => [d.id, d.label]));

/** Over this length the objective is no longer "formulé en très peu de lignes". */
const MAX_OBJECTIVE_CHARS = 160;

// ─── Deterministic layer ────────────────────────────────────────────────────

// Structural checks that need no LLM. Only returns a verdict for a dimension
// when the conclusion is certain from the Context alone — a missing required
// field or a malformed problématisation. Everything else is left to the LLM.
export function deterministicChecks(
  ctx: PurposeContext,
): Partial<Record<DimensionId, DimensionResult>> {
  const out: Partial<Record<DimensionId, DimensionResult>> = {};
  const has = (s: string): boolean => s.trim().length > 0;
  const mk = (id: DimensionId, verdict: DimensionVerdict, rationale: string): void => {
    out[id] = { id, label: LABEL_BY_ID.get(id)!, verdict, rationale };
  };

  if (!has(ctx.raisonDetre)) {
    mk('anchor-raison-detre', 'fail', "Aucune raison d'être : l'objectif n'est rattaché à rien qui lui donne du sens.");
    // Coherence to a missing anchor is not judgeable — fail it up front too.
    mk('objective-coherence', 'fail', "Cohérence non jugeable : pas de raison d'être à laquelle rattacher l'objectif.");
  }

  if (!has(ctx.scope) && !has(ctx.angle) && !has(ctx.granularity)) {
    mk('context-legitimation', 'fail', 'Aucun élément de contexte (scope, angle, granularité) pour légitimer l’objectif.');
  }

  if (!has(ctx.title)) {
    mk('concision-tangibility', 'fail', "Objectif non formulé.");
  } else if (ctx.title.trim().length > MAX_OBJECTIVE_CHARS) {
    mk('concision-tangibility', 'warn', `Formulation longue (${ctx.title.trim().length} car.) : viser quelques lignes tangibles et faciles à comprendre.`);
  }

  if (!has(ctx.problematisation)) {
    mk('problematisation', 'fail', "Pas de problématique : le purpose n'ouvre sur aucune question d'étude.");
  } else if (!ctx.problematisation.trim().endsWith('?')) {
    mk('problematisation', 'warn', 'La problématisation ne se termine pas par une question.');
  }

  return out;
}

// ─── LLM verdicts ───────────────────────────────────────────────────────────

const LlmVerdictSchema = z.object({
  id: z.string(),
  verdict: z.enum(['pass', 'warn', 'fail']),
  rationale: z.string(),
});

const LlmAuditResponseSchema = z.object({
  dimensions: z.array(LlmVerdictSchema),
});

export type LlmVerdicts = Partial<Record<DimensionId, { verdict: DimensionVerdict; rationale: string }>>;

/** Extract the first balanced JSON object from a raw LLM response. */
function extractJson(response: string): string {
  const start = response.indexOf('{');
  const end = response.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parsePurposeAudit: no JSON object found in LLM response');
  }
  return response.slice(start, end + 1);
}

// Registered parser (prompts.config.json → "audit-purpose-quality"). Validates
// the LLM JSON and keeps only known dimension ids; unknown ids are dropped
// rather than throwing, so a chatty model never breaks the run.
export function parsePurposeAuditResponse(response: string): LlmVerdicts {
  const parsed = LlmAuditResponseSchema.parse(JSON.parse(extractJson(response)));
  const out: LlmVerdicts = {};
  for (const d of parsed.dimensions) {
    if (LABEL_BY_ID.has(d.id)) {
      out[d.id as DimensionId] = { verdict: d.verdict, rationale: d.rationale };
    }
  }
  return out;
}

// ─── Merge ──────────────────────────────────────────────────────────────────

// Combine the two layers into the final per-dimension verdict list. A
// deterministic `fail` (missing/malformed field) always wins — the LLM cannot
// rescue a field that is not there. Otherwise the LLM verdict is preferred; a
// deterministic `warn` is the fallback; and a dimension nobody assessed is a
// `warn` (never a silent pass). `llm === null` means the LLM was unavailable
// (degraded run) — reflected in the rationale so the report stays honest.
export function mergeVerdicts(
  deterministic: Partial<Record<DimensionId, DimensionResult>>,
  llm: LlmVerdicts | null,
): DimensionResult[] {
  return PURPOSE_AUDIT_DIMENSIONS.map((d) => {
    const det = deterministic[d.id];
    const l = llm?.[d.id];
    if (det?.verdict === 'fail') return det;
    if (l) return { id: d.id, label: d.label, verdict: l.verdict, rationale: l.rationale };
    if (det) return det;
    return {
      id: d.id,
      label: d.label,
      verdict: 'warn' as const,
      rationale: llm ? "Non évalué par l'analyse." : 'Non évalué : LLM indisponible (audit dégradé).',
    };
  });
}

function toInsight(d: DimensionResult): StrategyResult['insights'][number] {
  return { text: `${d.verdict.toUpperCase()} · ${d.label} — ${d.rationale}`, by: METHOD_ID, type: 'other' };
}

// ─── Strategy ───────────────────────────────────────────────────────────────

export class WardleyIterationPurposeAuditPurposeQualityDefaultStrategy extends BaseStrategy<
  unknown,
  StrategyResult['insights']
> {
  private readonly _llmCall: LLMCall | null;

  constructor(options: { llmCall?: LLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<StrategyResult['insights']>> {
    const capturedAt = new Date().toISOString();

    const parsed = PurposeContextSchema.safeParse(input ?? {});
    if (!parsed.success) {
      const insights = [
        { text: 'audit-purpose-quality: input is not a valid Context envelope.', by: METHOD_ID, type: 'other' as const },
      ];
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights,
        result: insights,
      };
    }
    const ctx = parsed.data;

    const deterministic = deterministicChecks(ctx);

    // Resolve the LLM defensively: an unconfigured id or any registry error
    // degrades to deterministic-only rather than throwing.
    let llmCall = this._llmCall;
    if (!llmCall) {
      try {
        llmCall = getStrategyLLM('audit-purpose-quality');
      } catch {
        llmCall = null;
      }
    }

    let llm: LlmVerdicts | null = null;
    if (llmCall) {
      const call = llmCall;
      const p = getPrompt('audit-purpose-quality', 'default');
      const built = p.build({
        title: ctx.title,
        scope: ctx.scope,
        angle: ctx.angle,
        temporality: ctx.temporality,
        granularity: ctx.granularity,
        deliverables: ctx.deliverables.join('; '),
        raisonDetre: ctx.raisonDetre,
        problematisation: ctx.problematisation,
      });
      const response = await tryDegradeAmbient<string | null>(
        'llm:audit-purpose-quality',
        () => call(built.user, undefined, { systemPrompt: built.system }),
        null,
      );
      if (response != null) {
        llm = tryParse(() => p.parse(response) as LlmVerdicts);
      }
    }

    const merged = mergeVerdicts(deterministic, llm);
    const insights = merged.map(toInsight);

    return {
      signals: [
        { name: 'llm-used', value: llm !== null, source: 'computed', capturedAt },
        { name: 'dimensions', value: merged.length, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights,
      result: insights,
    };
  }
}

/** Run a parser, returning null on any failure (malformed LLM JSON never
 *  breaks the audit — the deterministic layer still stands). */
function tryParse(fn: () => LlmVerdicts): LlmVerdicts | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
