// Coerce a stringified JSON object/array back into a value.
//
// The runRecipe/runCommand `input` is `z.unknown()` (its shape is
// command-specific), so it has no `type` in the JSON Schema derived via
// z.toJSONSchema. MCP clients (Claude Code, claude.ai) then serialise a
// structured argument as a JSON *string* rather than an object. Strategies that
// do structural checks (`typeof input.components === 'object'`) see a string,
// fall back to an empty skeleton, and lose all caller context — producing
// generic maps. Defensive parse at the tool boundary restores the object.
//
// Only strings whose first non-space char is `{` or `[` are parsed; a plain
// string (a natural-language command, a bare id) neither starts that way nor
// parses, so it is returned untouched. Parse failure keeps the original string.
export function coerceJsonInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return input;
  try {
    return JSON.parse(trimmed);
  } catch {
    return input; // ponytail: malformed JSON stays a string; the strategy decides
  }
}
