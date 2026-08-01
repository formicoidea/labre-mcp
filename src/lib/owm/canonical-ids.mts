// Canonical WardleyMap interchange conventions, shared single source of truth.
//
// IDS — a canonical component id is the slug of its label. Several strategies
// must derive the SAME id independently (the value-chain ACL when building a
// map, image/parse/svg when re-deriving ids the SVG does not leak, owm/parse/dsl
// because OWM has no ids at all, and the dataset harness as oracle). If the
// algorithm ever changes (e.g. stripping diacritics so 'Commerçant' →
// 'commercant' instead of 'commerc-ant'), it must change everywhere at once —
// hence this module.
//
// VISIBILITY — the canonical schema puts 0 at the top of the value chain
// (visToY = plotTop + scalar * plotHeight); OWM DSL and the legacy
// PositionedValueChain put 1 there. The reconciling flip is self-inverse, so
// the same function serves both projection directions.

/** Deterministic slug of a label: lowercase → NFKD → non-[a-z0-9] runs → '-' → trim; 'node' when empty. */
export function slugify(name: string): string {
  return (
    name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'node'
  );
}

/**
 * Slug unique within `used` (`-2`, `-3`, … on clash — order-sensitive, first
 * caller wins the bare slug). Registers the returned id in `used`.
 */
export function uniqueSlug(name: string, used: Set<string>): string {
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/** Deterministic id per name for a whole list, unique within the map. */
export function buildIdMap(names: string[]): Map<string, string> {
  const used = new Set<string>();
  const byName = new Map<string, string>();
  for (const name of names) byName.set(name, uniqueSlug(name, used));
  return byName;
}

/** Self-inverse flip between the two visibility conventions, clamped to [0, 1]. */
export function flipVisibility(v: number): number {
  const flipped = 1 - v;
  return flipped < 0 ? 0 : flipped > 1 ? 1 : flipped;
}
