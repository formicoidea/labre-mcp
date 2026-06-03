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
  // populated as strategies migrate (CP3-CP6)
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
