// Anti-corruption layer: canonical WardleyMap ↔ legacy PositionedValueChain.
//
// The layout strategies speak `PositionedValueChain`; the canonical interchange
// type is the renderer package's `WardleyMap`. These pure projections bridge the
// two. Faithful on the common subset; chain-only metadata (imperatives,
// contextSummary, angle/scope/objective) and per-node analytical fields have no
// home in the renderer schema (they belong to the JSON-labre envelope) and are
// documented losses. A PositionedValueChain has no maturity assessment, so the
// produced map carries none (position.evolution.scalar is the rendered X only).
//
// VISIBILITY CONVENTION — the two sides are INVERTED and the ACL is the single
// point that reconciles them:
//   - legacy PositionedValueChain: `visibility` 0.95 = top/anchor, 0.10 = deep
//     (see compute-visibility.mts ANCHOR_VISIBILITY / Y_MIN — higher = more visible).
//   - renderer WardleyMap: `position.visibility.scalar` 0 = top/visible,
//     1 = bottom/invisible (visToY = plotTop + scalar*plotHeight).
// So a faithful projection maps `scalar = 1 - legacyVisibility` (and back). The
// X axis (evolution.scalar ↔ evolution) shares the [0,1] readability convention
// and is copied verbatim.

import { WardleyMapSchema, type WardleyMap } from '#schemas/wardley-map.schema.mjs';
import type {
  PositionedValueChain,
  PositionedComponent,
  ChainMetadata,
  ChainRole,
  OwmComponentType,
} from '#types/value-chain.mjs';
import type { CapabilityNature } from '#schemas/inputs.schema.mjs';

// Deterministic id from a name, unique within the map (`-2`, `-3`, … on clash).
function buildIdMap(names: string[]): Map<string, string> {
  const used = new Set<string>();
  const byName = new Map<string, string>();
  for (const name of names) {
    const base =
      name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    byName.set(name, id);
  }
  return byName;
}

// PositionedValueChain `type` (OWM enum) → renderer {type, subtype?}.
// market/ecosystem are renderer SUBTYPES of a `component`.
function toRendererType(c: PositionedComponent): { type: 'anchor' | 'component' | 'pipeline'; subtype?: string } {
  if (c.type === 'market') return { type: 'component', subtype: 'market' };
  if (c.type === 'ecosystem') return { type: 'component', subtype: 'ecosystem' };
  const type = c.type as 'anchor' | 'component' | 'pipeline';
  // Otherwise derive subtype from the chain role (need → userNeed, capability → functional).
  if (type === 'anchor') return { type };
  if (c.role === 'need') return { type, subtype: 'userNeed' };
  if (c.role === 'capability') return { type, subtype: 'functional' };
  return { type };
}

// Renderer {type, subtype} → PositionedValueChain OWM type + chain role (inverse).
function fromRendererType(type: string, subtype?: string): { owmType: OwmComponentType; role: ChainRole } {
  if (subtype === 'market') return { owmType: 'market', role: 'capability' };
  if (subtype === 'ecosystem') return { owmType: 'ecosystem', role: 'capability' };
  if (type === 'anchor') return { owmType: 'anchor', role: 'anchor' };
  const owmType = type as OwmComponentType;
  if (subtype === 'userNeed') return { owmType, role: 'need' };
  return { owmType, role: 'capability' };
}

// CapabilityNature ⊂ renderer NatureEnum, except 'none' (omitted).
const NATURE_PASSTHROUGH = new Set(['activity', 'practice', 'data', 'knowledge']);

// Reconcile the inverted visibility conventions (see file header). Self-inverse,
// so the same function serves both projection directions.
function flipVisibility(v: number): number {
  const flipped = 1 - v;
  return flipped < 0 ? 0 : flipped > 1 ? 1 : flipped;
}

export function fromPositionedValueChain(chain: PositionedValueChain): WardleyMap {
  const idByName = buildIdMap(chain.components.map((c) => c.name));

  const components = chain.components.map((c: PositionedComponent) => {
    const { type, subtype } = toRendererType(c);
    // CapabilityNature values (activity/practice/data/knowledge) are functional
    // natures; the renderer schema only allows them on subtype `functional`
    // (userNeed requires natural/anthropic, etc.). Attach only where valid.
    const nature =
      subtype === 'functional' && c.nature && NATURE_PASSTHROUGH.has(c.nature) ? c.nature : undefined;
    return {
      id: idByName.get(c.name)!,
      label: { name: c.name, position: { dx: c.label.dx, dy: c.label.dy } },
      type,
      ...(subtype ? { subtype } : {}),
      ...(nature ? { nature } : {}),
      ...(c.description ? { description: c.description } : {}),
      position: { evolution: { scalar: c.evolution }, visibility: { scalar: flipVisibility(c.visibility) } },
    };
  });

  const relations = chain.links.map((l, i) => ({
    id: `rel-${i + 1}`,
    consumer: idByName.get(l.from) ?? l.from,
    supplier: idByName.get(l.to) ?? l.to,
  }));

  // Parse to apply renderer defaults and guarantee a schema-valid canonical map.
  return WardleyMapSchema.parse({
    title: chain.metadata.title,
    ...(chain.metadata.contextSummary ? { context: chain.metadata.contextSummary } : {}),
    components,
    relations,
  });
}

export function toPositionedValueChain(map: WardleyMap): PositionedValueChain {
  const nameById = new Map(map.components.map((c) => [c.id, c.label.name]));

  const metadata: ChainMetadata = {
    title: map.title,
    angle: 'unspecified',
    scope: 'unspecified',
    objective: '',
    imperatives: [],
    temporality: 'present',
    contextSummary: typeof map.context === 'string' ? map.context : '',
  };

  const components: PositionedComponent[] = map.components.map((c) => {
    const { owmType, role } = fromRendererType(c.type, c.subtype);
    const nature = c.nature && NATURE_PASSTHROUGH.has(c.nature) ? (c.nature as CapabilityNature) : undefined;
    const pc: PositionedComponent = {
      name: c.label.name,
      type: owmType,
      role,
      visibility: flipVisibility(c.position.visibility.scalar),
      evolution: c.position.evolution.scalar,
      label: { dx: c.label.position?.dx ?? 0, dy: c.label.position?.dy ?? 0 },
    };
    if (nature) pc.nature = nature;
    if (c.description) pc.description = c.description;
    return pc;
  });

  const links = map.relations.map((r) => ({
    from: nameById.get(r.consumer) ?? r.consumer,
    to: nameById.get(r.supplier) ?? r.supplier,
  }));

  return { metadata, components, links };
}
