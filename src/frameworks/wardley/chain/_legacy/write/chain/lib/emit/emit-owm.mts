// Step 7 of the write:chain:* pipeline — OWM DSL emission.
//
// Produces a complete OWM document by composing primitives from the shared
// OWM DSL catalog (src/lib/owm/owm-dsl.mts):
//   - title (in the command's language, supplied by LLM #1)
//   - style (defaults to plain)
//   - optional size
//   - metadata comments
//   - one anchor declaration for the chain anchor
//   - component declarations for the rest
//   - directed flow links (A->B = A consumes B)
//
// We deliberately NOT use `pipeline { ... }` here — that grammar is for the
// SotA/legacy pattern emitted by work-on-evolution. write:chain:top-down
// generates a flat dependency graph.

import type { PositionedValueChain } from '#types/value-chain.mjs';
import {
  emitTitle,
  emitStyle,
  emitSize,
  emitAnchor,
  emitComponent,
  emitLink,
  emitComment,
  type OwmStyle,
  type OwmSize,
} from '#lib/owm/owm-dsl.mjs';

export interface EmitOwmOptions {
  /** Rendering style. Default: 'plain'. */
  style?: OwmStyle;
  /** Optional canvas size. Omit to let OWM auto-size. */
  size?: OwmSize;
}

const DEFAULT_STYLE: OwmStyle = 'plain';

/**
 * Build the OWM DSL document for a positioned value chain. Output layout:
 *   1. title
 *   2. style
 *   3. size?
 *   4. metadata comments (angle, scope, temporality, objective, imperatives, context)
 *   5. anchor
 *   6. components
 *   7. links
 */
export function generateChainOwmSyntax(
  chain: PositionedValueChain,
  options: EmitOwmOptions = {},
): string {
  const { metadata, components, links } = chain;
  const style = options.style ?? DEFAULT_STYLE;
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────
  if (metadata.title) lines.push(emitTitle(metadata.title));
  lines.push(emitStyle(style));
  if (options.size) lines.push(emitSize(options.size));

  // ── Metadata comments ──────────────────────────────────────────────
  if (metadata.angle)       lines.push(emitComment(`angle: ${metadata.angle}`));
  if (metadata.scope)       lines.push(emitComment(`scope: ${metadata.scope}`));
  if (metadata.temporality) lines.push(emitComment(`temporality: ${metadata.temporality}`));
  if (metadata.objective)   lines.push(emitComment(`objective: ${metadata.objective}`));
  if (metadata.imperatives.length > 0) {
    lines.push(emitComment(`imperatives: ${metadata.imperatives.join('; ')}`));
  }
  if (metadata.contextSummary) lines.push(emitComment(`context: ${metadata.contextSummary}`));

  // ── Anchor first, then other components ─────────────────────────────
  const anchor = components.find(c => c.role === 'anchor');
  const others = components.filter(c => c.role !== 'anchor');

  if (anchor) {
    lines.push(emitAnchor(
      anchor.name,
      { visibility: anchor.visibility, evolution: anchor.evolution },
      anchor.label,
    ));
  }

  for (const c of others) {
    lines.push(emitComponent(
      c.name,
      { visibility: c.visibility, evolution: c.evolution },
      c.label,
    ));
  }

  // ── Links ───────────────────────────────────────────────────────────
  for (const link of links) {
    lines.push(emitLink(link.from, link.to));
  }

  return lines.join('\n');
}
