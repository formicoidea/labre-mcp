// Real strategy `render:wardley-map:owm:emit:dsl`.
//
// Projects a canonical WardleyMap (the structured object carried by JSON-labre)
// onto the OWM (onlinewardleymaps.com) DSL. Fully deterministic — no LLM, no I/O.
// Every OWM token is produced by the shared kit `#lib/owm/owm-dsl.mjs`, which is
// the single source of truth for the grammar (project rule: every OWM emitter
// goes through that module).
//
// ROUND-TRIP CONTRACT (ast-schema.md, render domain § 2.3):
//   - `emit(parse(dsl))` is BYTE-identical for any DSL this emitter produced;
//   - `parse(emit(map))` is semantically identical on the subset OWM can express
//     (declaration order, labels, relations, positions).
// The emitted vocabulary is deliberately the subset the vendored cli-owm parser
// round-trips: `title`, `anchor`, `component` (+ optional `label [dx, dy]`) and
// `A->B` links. Anything else is a documented loss surfaced as an insight.
//
// DOCUMENTED LOSSES (no OWM equivalent, or no equivalent the vendored parser
// reads back): component ids (OWM has no ids — parse re-derives them from the
// label), subtype, nature, description, color, method/inertia/accelerator/step
// decorators, evolvesTo, pipeline geometry, relation ids/type/flow, anchor label
// offsets (the OWM anchor grammar has no `label`), map context and renderConfig.
//
// Graceful by design (degradation-first): during the incremental migration an
// upstream step may still be a mock and hand us a non-canonical object, and a
// label may exceed what OWM accepts. Rather than crash the recipe we flag it
// with an insight and return an empty DSL (emitted: false).

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import { withoutRenderConfig } from '#schemas/render-config-passthrough.mjs';
import {
  emitAnchor,
  emitComponent,
  emitLink,
  emitTitle,
  type OwmCoords,
  type OwmLabelOffset,
} from '#lib/owm/owm-dsl.mjs';
import { flipVisibility } from '#lib/owm/canonical-ids.mjs';

const METHOD_ID = 'render:wardley-map:owm:emit:dsl';

export interface RenderWardleyMapOwmEmitDslResult {
  dsl: string;
  emitted: boolean;
}

// VISIBILITY CONVENTION — OWM and the canonical schema disagree on which end of
// the Y axis carries 0, and this file is one of the two points that reconcile
// them (the other being the parse strategy):
//   - OWM: `visibilityToY(v) = (1 - v) * height` (cli-owm render.mts) → 1 = top.
//   - canonical: `visToY = plotTop + scalar * plotHeight` → 0 = top/visible.
// So the projection is `owmVisibility = 1 - scalar` — the shared self-inverse
// `flipVisibility` (#lib/owm/canonical-ids.mjs).

// Sequences that break the OWM line grammar: the parser splits declarations on
// ' [' , links on '->' and link context on ';', and `\n` is our own in-label
// line-break marker (see formatComponentName). A label carrying any of them
// cannot survive a round-trip, so we flag it rather than silently corrupt it.
const GRAMMAR_HOSTILE = /\[|\]|->|;|\\n|\n/;

/** Accumulate one insight per distinct loss reason (never one per component). */
function note(losses: Map<string, number>, reason: string): void {
  losses.set(reason, (losses.get(reason) ?? 0) + 1);
}

/**
 * Pure projection canonical WardleyMap → OWM DSL. Declaration order is the
 * component array order, so `parse` can restore it by sorting on line number.
 * Throws when a label exceeds MAX_LABEL_LENGTH (formatComponentName's contract).
 */
function emitMap(map: WardleyMap, losses: Map<string, number>): string {
  const lines: string[] = [emitTitle(map.title)];
  // OWM identifies components by their (formatted) name in link lines; keep the
  // canonical id → label mapping so relations can be resolved back to names.
  const labelById = new Map<string, string>();

  if (map.context !== undefined) note(losses, 'map `context` has no OWM equivalent and was dropped');

  for (const c of map.components) {
    labelById.set(c.id, c.label.name);

    const coords: OwmCoords = {
      visibility: flipVisibility(c.position.visibility.scalar),
      evolution: c.position.evolution.scalar,
    };

    if (c.label.name.trim().length === 0) {
      note(losses, 'a component has an empty label; OWM substitutes "Component" and the round-trip is not byte-stable');
    }
    if (GRAMMAR_HOSTILE.test(c.label.name)) {
      note(losses, 'a label contains characters the OWM grammar reserves ([ ] -> ; \\n); the round-trip is not byte-stable');
    }
    if (c.subtype !== undefined || c.nature !== undefined) {
      note(losses, 'component taxonomy (subtype/nature) has no OWM equivalent and was dropped');
    }
    if (c.description !== undefined) note(losses, 'component descriptions have no OWM equivalent and were dropped');
    if (c.evolvesTo !== undefined && c.evolvesTo.length > 0) {
      note(losses, 'evolvesTo targets are not projected (the OWM `evolve` directive is out of this emitter’s vocabulary)');
    }
    if (c.method || c.inertia || c.accelerator || c.deaccelerator || c.step || c.color) {
      note(losses, 'component decorators (method/inertia/accelerator/step/color) have no OWM equivalent and were dropped');
    }

    if (c.type === 'anchor') {
      // AnchorExtractionStrategy runs setName + setCoords ONLY — the OWM anchor
      // grammar carries no `label [dx, dy]`, so an offset would be lost on the
      // way back and break byte-identity. Drop it explicitly instead.
      if (c.label.position) note(losses, 'anchor label offsets have no OWM equivalent and were dropped');
      lines.push(emitAnchor(c.label.name, coords));
      continue;
    }

    if (c.type === 'pipeline') {
      note(losses, 'pipelines are emitted as plain components (pipeline geometry is not projected)');
    }
    const offset: OwmLabelOffset | undefined = c.label.position
      ? { dx: c.label.position.dx, dy: c.label.position.dy }
      : undefined;
    lines.push(emitComponent(c.label.name, coords, offset));
  }

  for (const r of map.relations) {
    const consumer = labelById.get(r.consumer);
    const supplier = labelById.get(r.supplier);
    if (consumer === undefined || supplier === undefined) {
      note(losses, 'relation(s) referencing an unknown component id were dropped');
      continue;
    }
    if (r.type !== 'DependsOn' || r.flow !== undefined) {
      note(losses, 'relation type/flow annotations are not projected (only the plain `A->B` dependency is emitted)');
    }
    // OWM `A->B` reads "A consumes B": from = consumer, to = supplier.
    lines.push(emitLink(consumer, supplier));
  }

  return lines.join('\n');
}

export class RenderWardleyMapOwmEmitDslStrategy extends BaseStrategy<
  unknown,
  RenderWardleyMapOwmEmitDslResult
> {
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(
    input: unknown,
    _context: RequestContext,
  ): Promise<StrategyResult<RenderWardleyMapOwmEmitDslResult>> {
    const capturedAt = new Date().toISOString();
    // `renderConfig` travels in INPUT shape and its parsed form is not re-parsable
    // (see render-config-passthrough.mts); it carries nothing OWM can express, so
    // strip it before validating the geometry.
    const parsed = WardleyMapSchema.safeParse(withoutRenderConfig(input));

    if (!parsed.success) {
      return {
        signals: [{ name: 'input-valid', value: false, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: 'cannot emit: input is not a canonical WardleyMap (upstream step not yet promoted?)',
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: { dsl: '', emitted: false },
      };
    }

    const map = parsed.data;
    const losses = new Map<string, number>();
    let dsl: string;
    try {
      dsl = emitMap(map, losses);
    } catch (err) {
      // The only expected throw is formatComponentName rejecting a label longer
      // than MAX_LABEL_LENGTH — a schema-valid map OWM simply cannot carry.
      return {
        signals: [{ name: 'input-valid', value: true, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [
          {
            text: `cannot emit: ${err instanceof Error ? err.message : String(err)}`,
            by: METHOD_ID,
            type: 'other',
          },
        ],
        result: { dsl: '', emitted: false },
      };
    }

    return {
      signals: [
        { name: 'componentCount', value: map.components.length, source: 'computed', capturedAt },
        { name: 'relationCount', value: map.relations.length, source: 'computed', capturedAt },
        { name: 'dslBytes', value: dsl.length, source: 'computed', capturedAt },
      ],
      reasoning: [],
      insights: [...losses.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([reason, count]) => ({
          text: count > 1 ? `${reason} (${count} occurrences)` : reason,
          by: METHOD_ID,
          type: 'other' as const,
        })),
      result: { dsl, emitted: true },
    };
  }
}
