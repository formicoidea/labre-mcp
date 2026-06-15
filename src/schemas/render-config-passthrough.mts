// Render-config passthrough helpers.
//
// The renderer's `renderConfig` is a Zod *pipe*: its parsed OUTPUT shape
// (e.g. `{ styling: { background: { evolutionXAxis: { show } } } }`) is NOT a
// valid INPUT, so re-parsing a map that already carries a resolved renderConfig
// throws `unrecognized_keys`. The value-chain pipeline therefore carries the
// view config in INPUT shape and only resolves it once, at render time.
//
// These helpers let each layout strategy validate the map geometry while leaving
// the (input-shape) renderConfig untouched: strip it before parsing, read the
// raw blob, and re-attach it to the result.

/** The raw, unparsed `renderConfig` blob on an input (input shape), or undefined. */
export function readRenderConfig(input: unknown): unknown {
  return input && typeof input === 'object'
    ? (input as Record<string, unknown>).renderConfig
    : undefined;
}

/** A shallow copy of the input with `renderConfig` removed, safe to schema-parse. */
export function withoutRenderConfig(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const { renderConfig: _omit, ...rest } = input as Record<string, unknown>;
  return rest;
}
