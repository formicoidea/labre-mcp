// Real strategy `render:wardley-map:image:parse:png`.
//
// PNG of a Wardley Map — ours or a screenshot found in the wild — → canonical
// WardleyMap, through a vision LLM. Unlike its sibling `parse:svg`, this one is
// NON-DETERMINISTIC by construction: it reads pixels the way a human would, so
// its quality is an EVAL question (measured later against the round-trip
// dataset), never a unit-test question. The unit tests below pin the CONTRACT
// — projection, id derivation, degradation — never the model's accuracy.
//
// ── Two stages, deliberately separated ─────────────────────────────────────
//
//   1. EXTRACTION (non-deterministic). The vision model returns a strict,
//      deliberately minimal intermediate JSON:
//        { title, components: [{ name, type, evolution, visibility }],
//          relations: [{ consumer, supplier }] }
//      validated by `VisionExtractionSchema` below. The model is never asked to
//      produce ids, relation ids, subtypes or natures: every field it emits is
//      something legible on the image, nothing it would have to invent.
//
//   2. PROJECTION (deterministic, pure). `projectToWardleyMap` turns that
//      intermediate into the canonical map: slugified de-duplicated ids,
//      name→id resolution for relations, `rel-N` ids, then
//      `WardleyMapSchema` validation. Same function for every call, fully
//      testable without a model.
//
// The seam matters: everything uncertain is confined to stage 1, so a bad
// extraction degrades into warnings instead of corrupting the canonical type.
//
// ── Where uncertainty lives ────────────────────────────────────────────────
//
// NOWHERE in the map. The canonical WardleyMap carries no confidence field and
// must not grow one (ast-schema § 2.0): the model's hesitations, the dropped
// constructs and the "this came from a vision model" caveat all travel in the
// JSON-labre envelope, as `signals` / `insights` / `reasoning`.
//
// ── Coordinate convention ──────────────────────────────────────────────────
//
// The prompt asks for SCREEN-SPACE scalars, which is exactly the canonical
// convention — evolution 0 = left, visibility 0 = TOP/most visible
// (`visToY = plotTop + scalar * plotHeight`). So the projection copies both
// verbatim: no flip here, unlike the value-chain ACL which bridges the inverted
// legacy convention.
//
// ── Known limitations (warnings, never a crash) ────────────────────────────
//   - notes, annotations and flow labels are not extracted; the model is told
//     to ignore them. Colors, inertia walls, movement (evolve) arrows and
//     pipeline bands ARE extracted when clearly drawn (optional fields).
//   - subtypes (userNeed / market / ecosystem / …) and natures are not
//     recovered: everything is `component` or `anchor`.
//   - relation types (DependsOn / Flow / Constraint) are not recovered; the
//     schema default (DependsOn) applies.
//   - `label.position` (dx/dy) is not recovered — see parse:svg for why pinning
//     labels read back from a render is actively harmful.
//   - the intermediate is validated as a WHOLE: one out-of-range scalar
//     discards the entire extraction rather than that single component. That is
//     the strict contract asked of stage 1; revisit only with eval evidence.

import { z } from 'zod';
import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { validateComponent } from '@formicoidea/wardley-map-renderer';
import type { LLMCall } from '#types/llm.mjs';
import { getStrategyVisionLLM } from '#lib/llm/registry.mjs';
import { uniqueSlug } from '#lib/owm/canonical-ids.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import { tryDegradeAmbient } from '#lib/degradation/index.mjs';

const METHOD_ID = 'render:wardley-map:image:parse:png';

/** Key under which the prompt pair and the LLM route are declared
 *  (prompts.config.json / llm.config.json). */
const PROMPT_ID = 'render-image-parse-png';

/** Max characters of raw model output kept as a reasoning trace. Vision answers
 *  are small; the bound only protects the artefact from a runaway response. */
const REASONING_TRACE_LIMIT = 4000;

// ── Input contract ─────────────────────────────────────────────────────────

/** Local input contract — the strategy only needs the image bytes. */
const ParsePngInputSchema = z.object({
  /** Raw base64 payload, WITHOUT a `data:` prefix (the LLM layer adds it). */
  pngBase64: z.string().min(1),
  /** Declared for forward-compatibility; PNG is the only shape today, and the
   *  LLM image channel is typed the same way. */
  mediaType: z.literal('image/png').default('image/png'),
});

export interface RenderWardleyMapImageParsePngResult {
  /** Canonical map, or null when the image could not be transcribed. */
  map: WardleyMap | null;
  parsed: boolean;
  /** Human-readable notes about everything dropped, approximated or refused. */
  warnings: string[];
}

// ── Stage 1: the intermediate representation ───────────────────────────────

/** One node as the vision model reports it. Strict on purpose: an out-of-range
 *  or non-numeric scalar is a transcription failure, not something to repair.
 *  The decorator fields are optional and only present when actually drawn
 *  (color, inertia wall, movement arrow, pipeline band). */
const VisionComponentSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['component', 'anchor']).default('component'),
  evolution: z.number().min(0).max(1),
  visibility: z.number().min(0).max(1),
  color: z.string().min(1).optional(),
  inertia: z.boolean().optional(),
  evolvesTo: z.number().min(0).max(1).optional(),
  pipeline: z
    .object({ evoStart: z.number().min(0).max(1), evoEnd: z.number().min(0).max(1) })
    .optional(),
});

/** One dependency, by NAME — the model never sees our ids. */
const VisionRelationSchema = z.object({
  consumer: z.string().min(1),
  supplier: z.string().min(1),
});

/** The whole intermediate. Unknown keys are stripped (models are chatty); the
 *  keys we do read are validated strictly. */
const VisionExtractionSchema = z.object({
  title: z.string().default(''),
  components: z.array(VisionComponentSchema).default([]),
  relations: z.array(VisionRelationSchema).default([]),
});

export type VisionExtraction = z.infer<typeof VisionExtractionSchema>;

/** Extract the first balanced JSON object from a raw response. Tolerates the
 *  prose and the code fences the prompt forbids but models emit anyway. */
function extractJsonObject(response: string): string {
  const start = response.indexOf('{');
  const end = response.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON object found in the response');
  }
  return response.slice(start, end + 1);
}

/**
 * Parse + strictly validate the model's answer. Throws on anything malformed;
 * the caller turns that into a warning, never into a crash.
 * Exported for the tests and for the future eval harness.
 */
export function parseVisionExtraction(response: string): VisionExtraction {
  // any: JSON.parse is untyped by nature; the value is narrowed on the very
  // next line by VisionExtractionSchema.
  const raw: unknown = JSON.parse(extractJsonObject(response));
  return VisionExtractionSchema.parse(raw);
}

// ── Stage 2: the deterministic projection ──────────────────────────────────

/**
 * Deterministic id from a name, unique within the map (`-2`, `-3`, … on clash).
 *
 * Byte-for-byte the algorithm of `buildIdMap` in `../../acl/value-chain.mts`
 * (recopied on purpose: a shared extraction is in flight elsewhere, and a map
 * transcribed from a PNG must land on the very same ids as the same map built
 * through the value-chain ACL).
 *
 * Returns ids POSITIONALLY, unlike the ACL's name→id map: a vision extraction
 * can legitimately repeat a label — two dots really can be labelled the same on
 * a hand-drawn map — where a PositionedValueChain cannot. `firstIdByName`
 * resolves relations, which the model expresses by name.
 */
function buildIds(names: readonly string[]): { ids: string[]; firstIdByName: Map<string, string> } {
  const used = new Set<string>();
  const ids: string[] = [];
  const firstIdByName = new Map<string, string>();
  for (const name of names) {
    const id = uniqueSlug(name, used);
    ids.push(id);
    if (!firstIdByName.has(name)) firstIdByName.set(name, id);
  }
  return { ids, firstIdByName };
}

/** Lookup key tolerating the casing/whitespace drift between the `components`
 *  list and the `relations` list of the same answer. */
function lookupKey(name: string): string {
  return name.trim().toLowerCase();
}

export interface ProjectionOutcome {
  map: WardleyMap | null;
  warnings: string[];
}

/**
 * Intermediate → canonical WardleyMap. Pure and total: every rejection is a
 * warning, the function never throws.
 */
export function projectToWardleyMap(extraction: VisionExtraction): ProjectionOutcome {
  const warnings: string[] = [];

  const names = extraction.components.map((c) => c.name);
  const { ids, firstIdByName } = buildIds(names);

  for (const c of extraction.components) {
    if (c.pipeline !== undefined && c.type === 'anchor') {
      warnings.push(`pipeline band on anchor "${c.name}" ignored (anchors cannot carry pipelineGeometry)`);
    }
  }

  const seenNames = new Set<string>();
  for (const name of names) {
    if (seenNames.has(name)) {
      warnings.push(
        `component name "${name}" appears more than once: ids were de-duplicated, ` +
          'and relations targeting that name all resolve to the first occurrence',
      );
    }
    seenNames.add(name);
  }

  const components = extraction.components.map((c, i) => ({
    id: ids[i],
    label: { name: c.name },
    // A pipeline band promotes the node to the canonical `pipeline` type —
    // the renderer refuses pipelineGeometry on any other type (validateMap).
    type: c.pipeline !== undefined && c.type === 'component' ? ('pipeline' as const) : c.type,
    position: {
      evolution: { scalar: c.evolution },
      visibility: { scalar: c.visibility },
    },
    ...(c.color !== undefined ? { color: c.color } : {}),
    ...(c.inertia === true ? { inertia: true } : {}),
    // A movement arrow moves along X: the target keeps the component's row.
    // The renderer draws the inertia wall from the TARGET's flag — mirror it.
    ...(c.evolvesTo !== undefined
      ? {
          evolvesTo: [
            {
              position: {
                evolution: { scalar: c.evolvesTo },
                visibility: { scalar: c.visibility },
              },
              ...(c.inertia === true ? { inertia: true } : {}),
            },
          ],
        }
      : {}),
    ...(c.pipeline !== undefined && c.type === 'component'
      ? {
          pipelineGeometry: {
            evoStart: Math.min(c.pipeline.evoStart, c.pipeline.evoEnd),
            evoEnd: Math.max(c.pipeline.evoStart, c.pipeline.evoEnd),
            visStart: c.visibility,
            visEnd: c.visibility,
          },
        }
      : {}),
  }));

  // Case/whitespace-tolerant name → id index for relation resolution.
  const idByKey = new Map<string, string>();
  for (const [name, id] of firstIdByName) {
    const key = lookupKey(name);
    if (!idByKey.has(key)) idByKey.set(key, id);
  }

  const relations: Array<{ id: string; consumer: string; supplier: string }> = [];
  for (const rel of extraction.relations) {
    const consumer = idByKey.get(lookupKey(rel.consumer));
    const supplier = idByKey.get(lookupKey(rel.supplier));
    if (consumer === undefined || supplier === undefined) {
      const unknown = [
        ...(consumer === undefined ? [`"${rel.consumer}"`] : []),
        ...(supplier === undefined ? [`"${rel.supplier}"`] : []),
      ].join(' and ');
      warnings.push(`relation dropped: ${unknown} is not a transcribed component name`);
      continue;
    }
    if (consumer === supplier) {
      warnings.push(`relation dropped: "${rel.consumer}" depends on itself`);
      continue;
    }
    relations.push({ id: `rel-${relations.length + 1}`, consumer, supplier });
  }

  // safeParse, not parse: the canonical schema is the last gate, and a gate
  // that throws would break the degradation contract this strategy owes the
  // MCP dispatch. A rejection here means stage 2 produced something invalid,
  // which is a bug in this file — surface it, do not crash the recipe.
  const validated = WardleyMapSchema.safeParse({
    title: extraction.title,
    components,
    relations,
  });
  if (!validated.success) {
    return {
      map: null,
      warnings: [
        ...warnings,
        `transcribed map is not schema-valid: ${validated.error.issues.map((i) => i.message).join('; ')}`,
      ],
    };
  }

  // Output oracle: every component must be STRUCTURALLY valid at render — a
  // projection the renderer would refuse (e.g. pipelineGeometry on a
  // non-pipeline type) is a bug in this file. validateComponent only (the
  // map-level validateMap adds editorial advisories like "should have an
  // anchor" that are properties of the source image, not projection bugs).
  // Surfaced as warnings, never a crash (degradation-first).
  for (const component of validated.data.components) {
    for (const issue of validateComponent(component)) {
      warnings.push(`render-validity: ${issue}`);
    }
  }
  return { map: validated.data, warnings };
}

// ── Strategy ───────────────────────────────────────────────────────────────

export class RenderWardleyMapImageParsePngStrategy extends BaseStrategy<
  // any: the strategy contract hands over an unvalidated envelope payload,
  // narrowed right below by ParsePngInputSchema (same shape as parse:svg).
  unknown,
  RenderWardleyMapImageParsePngResult
> {
  private readonly _llmCall: LLMCall | null;

  /** `llmCall` is the test/eval injection seam — the same one the LLM-backed
   *  Wardley strategies use. In production the call is resolved from the
   *  registry, which refuses any provider that cannot carry an image. */
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
  ): Promise<StrategyResult<RenderWardleyMapImageParsePngResult>> {
    const capturedAt = new Date().toISOString();
    const validated = ParsePngInputSchema.safeParse(input);

    if (!validated.success) {
      // Degradation-first: an upstream mock may hand us anything at all.
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: 'cannot parse: input is not { pngBase64: string } (upstream step not yet promoted?)',
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: { map: null, parsed: false, warnings: ['input is not { pngBase64: string }'] },
      };
    }

    const { pngBase64, mediaType } = validated.data;
    const warnings: string[] = [];
    const reasoning: StrategyResult<RenderWardleyMapImageParsePngResult>['reasoning'] = [];

    // Resolve the vision call. A provider without an image channel throws here
    // with an explicit "does not support image input" — that message is the
    // actionable part of the degradation, so it is carried into the warnings
    // verbatim instead of being swallowed.
    let llmCall = this._llmCall;
    if (llmCall === null) {
      try {
        llmCall = getStrategyVisionLLM(PROMPT_ID);
      } catch (err) {
        llmCall = null;
        warnings.push(`no vision-capable LLM available: ${(err as Error).message}`);
      }
    }

    let map: WardleyMap | null = null;
    if (llmCall !== null) {
      const call = llmCall;
      const prompt = getPrompt(PROMPT_ID);
      const built = prompt.build({ mediaType });

      const response = await tryDegradeAmbient<string | null>(
        `llm:${PROMPT_ID}`,
        () =>
          call(built.user, undefined, {
            systemPrompt: built.system,
            images: [{ mediaType, base64: pngBase64 }],
          }),
        null,
      );

      if (response === null) {
        warnings.push('vision LLM call failed or returned nothing');
      } else {
        reasoning.push({ by: METHOD_ID, text: response.slice(0, REASONING_TRACE_LIMIT) });
        // The prompt frames its answer in MAP_START/MAP_END; the registry's
        // delimited parser peels that off. A model that ignored the markers
        // still has a chance through the raw-response fallback.
        let payload: string = response;
        try {
          const block = prompt.parse(response) as string | null;
          if (typeof block === 'string' && block.length > 0) payload = block;
        } catch {
          // Parser resolution problem — fall through to the raw response.
        }

        let extraction: VisionExtraction | null = null;
        try {
          extraction = parseVisionExtraction(payload);
        } catch (err) {
          warnings.push(`vision response is not a valid transcription: ${(err as Error).message}`);
        }

        if (extraction !== null) {
          const projected = projectToWardleyMap(extraction);
          map = projected.map;
          warnings.push(...projected.warnings);
        }
      }
    }

    const signals: StrategyResult<RenderWardleyMapImageParsePngResult>['signals'] = [
      { name: 'input-valid', value: true, source: 'computed', capturedAt },
      { name: 'llm-used', value: llmCall !== null, source: 'computed', capturedAt },
      { name: 'componentCount', value: map?.components.length ?? 0, source: 'computed', capturedAt },
      { name: 'relationCount', value: map?.relations.length ?? 0, source: 'computed', capturedAt },
    ];

    const insights: StrategyResult<RenderWardleyMapImageParsePngResult>['insights'] = [];
    if (map === null) {
      insights.push({
        text: `cannot parse the image: ${warnings.join('; ')}`,
        by: METHOD_ID,
        type: 'other',
      });
    } else {
      // The caveat belongs here, in the envelope — never in the map.
      insights.push({
        text:
          `Map transcribed from an image by a vision model: ${map.components.length} component(s), ` +
          `${map.relations.length} relation(s). Positions are visual estimates, and subtypes, ` +
          'natures and relation types are not recovered — treat it as a draft to review, ' +
          'not as a faithful round-trip.',
        by: METHOD_ID,
        type: 'other',
      });
      if (warnings.length > 0) {
        insights.push({
          text: `Image partially transcribed, ${warnings.length} construct(s) dropped or approximated: ${warnings.join('; ')}`,
          by: METHOD_ID,
          type: 'other',
        });
      }
    }

    return { signals, reasoning, insights, result: { map, parsed: map !== null, warnings } };
  }
}
