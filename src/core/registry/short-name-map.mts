// Short-name <-> 5-segment methodId mapping (ast-schema.md v0.1.0).
//
// llm.config.json and tool.config.json use short names (e.g. "s-curve",
// "llm-direct") for human readability. The kernel resolves them to canonical
// 5-segment methodIds via this map.
//
// Mappings are populated incrementally as strategies migrate to the v0.1.0
// grammar in CP3-CP6 of the migration. The empty initial map is intentional:
// callers that pass an already-canonical methodId pass through unchanged.

export const SHORT_NAME_TO_METHOD_ID: Record<string, string> = {
  // CP3 — chain strategies
  "write-chain": "wardley:map:value-chain:generate:top-down",
  // CP3 — render-owm strategies (no LLM, no short-name needed but registered
  // for symmetry; llm.config.json does not reference them).
  // CP5 — evolution capacity strategies (positioning functional components in evolution)
  "s-curve":              "wardley:map:climate:position-functional-in-evolution:s-curve",
  "llm-direct":           "wardley:map:climate:position-functional-in-evolution:llm-direct",
  "publication-analysis": "wardley:map:climate:position-functional-in-evolution:publication-analysis",
  "cpc-evolution":        "wardley:map:climate:position-functional-in-evolution:cpc-evolution",
  "timeline-benchmark":   "wardley:map:climate:position-functional-in-evolution:timeline-benchmark",
  "logprob-distribution": "wardley:map:climate:position-functional-in-evolution:logprob-distribution",
  // CP6 — solution + anchor + identify
  "properties-strategy": "wardley:map:climate:position-solution-in-evolution:property-assessment",
  "anchor-evolution":    "wardley:map:climate:position-anchor-in-evolution:culture-phase",
  "identify-capability": "wardley:map:node:identify:default",
};

export const METHOD_ID_TO_SHORT_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(SHORT_NAME_TO_METHOD_ID).map(([shortName, methodId]) => [methodId, shortName]),
);

/** Resolve a short config name or canonical methodId to a canonical 5-segment methodId.
 *  Unknown inputs pass through unchanged — callers that already hold a methodId
 *  don't need to know whether their input is a short name or a full id. */
export function resolveStrategy(shortNameOrMethodId: string): string {
  return SHORT_NAME_TO_METHOD_ID[shortNameOrMethodId] ?? shortNameOrMethodId;
}

/** Resolve a methodId to its short config name, or undefined if no mapping
 *  is registered. */
export function getShortName(methodId: string): string | undefined {
  return METHOD_ID_TO_SHORT_NAME[methodId];
}
