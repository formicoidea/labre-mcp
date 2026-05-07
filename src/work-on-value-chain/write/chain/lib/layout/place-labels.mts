// Step 5 of the write:chain:* pipeline — deterministic label placement.
//
// Rules (V2):
//   1. Leaf component (no outgoing edge):
//        label below-center                → [0, +25]
//   2. Component near the right edge of the map (X >= 0.95):
//        label on the LEFT                  → [-100, 0]
//   3. Component near the left edge of the map (X <= 0.05):
//        label on the RIGHT                 → [+20, 0]
//   4. Component in the middle of the map with outgoing edges:
//        the label "flees" the dense side. Count children sitting to the
//        right vs to the left of the component:
//          - more right children  → label LEFT  → [-100, 0]
//          - more left children   → label RIGHT → [+20, 0]
//          - tie                  → label LEFT  (default-deterministic)
//
// V1 used a round-robin palette regardless of topology. The new rule
// derives the offset from each component's local context, mirroring the
// patterns observed in user-curated maps.

import type {
  LabelOffset,
  PositionedComponent,
  PositionedValueChain,
} from '../../../../../types/value-chain.mjs';

export const LABEL_BELOW: LabelOffset  = { dx: 0,    dy: 25 };
export const LABEL_LEFT: LabelOffset   = { dx: -100, dy: 0 };
export const LABEL_RIGHT: LabelOffset  = { dx: 20,   dy: 0 };

export const RIGHT_EDGE_THRESHOLD = 0.95;
export const LEFT_EDGE_THRESHOLD  = 0.05;

/** Decide the label offset for a single component given the chain context. */
export function pickLabelOffset(
  component: PositionedComponent,
  chain: PositionedValueChain,
): LabelOffset {
  const outgoing = chain.links.filter(l => l.from === component.name);

  // Rule 1: leaf → below
  if (outgoing.length === 0) return LABEL_BELOW;

  // Rule 2: right edge → left
  if (component.evolution >= RIGHT_EDGE_THRESHOLD) return LABEL_LEFT;

  // Rule 3: left edge → right
  if (component.evolution <= LEFT_EDGE_THRESHOLD) return LABEL_RIGHT;

  // Rule 4: middle → flee the dense side
  const childByName = new Map(chain.components.map(c => [c.name, c] as const));
  let rightCount = 0;
  let leftCount = 0;
  for (const link of outgoing) {
    const child = childByName.get(link.to);
    if (!child) continue;
    if (child.evolution > component.evolution) rightCount++;
    else if (child.evolution < component.evolution) leftCount++;
  }

  if (rightCount > leftCount) return LABEL_LEFT;
  if (leftCount > rightCount) return LABEL_RIGHT;
  return LABEL_LEFT;
}

/**
 * Assign a LabelOffset to every component using the deterministic rule
 * above. Returns a new chain (input is not mutated).
 */
export function placeLabels(chain: PositionedValueChain): PositionedValueChain {
  return {
    metadata: chain.metadata,
    links: chain.links,
    components: chain.components.map(c => ({
      ...c,
      label: pickLabelOffset(c, chain),
    })),
  };
}
