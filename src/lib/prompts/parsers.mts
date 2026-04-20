// Generic LLM response parsing helpers.
//
// parseKeyValueBlock: extract `key=value` (or `key: value`) lines by key name.
// Returns raw strings — callers coerce (parseFloat, parseInt, enum, …) and
// apply domain-specific defaults. Keeping coercion at the call site preserves
// the lenient parseFloat semantics (e.g. "0.75 (commodity)" → 0.75) that some
// LLM responses rely on; z.coerce.number() would reject those.
//
// parseDelimitedBlock: extract content between START/END markers on their own
// lines (e.g. EVIDENCE_START / EVIDENCE_END).

export interface KeyValueOptions {
  /** '=' (default) matches strict `key=value`. 'any' matches `key:value`,
   *  `key value`, `key = value`, etc. — covers llm-direct / timeline-benchmark
   *  which use `[:\s=]*` as separator. */
  separator?: '=' | 'any';
  /** When true (default), the key must start at the beginning of a line (^).
   *  When false, the key may appear anywhere. llm-direct and timeline-benchmark
   *  use unanchored matching. */
  anchored?: boolean;
}

export function parseKeyValueBlock(
  text: string,
  keys: readonly string[],
  options: KeyValueOptions = {},
): Record<string, string | undefined> {
  const { separator = '=', anchored = true } = options;
  const sepRe = separator === 'any' ? '[:\\s=]*' : '\\s*=\\s*';
  const prefix = anchored ? '^' : '';
  const flags = anchored ? 'mi' : 'i';

  const out: Record<string, string | undefined> = {};
  for (const key of keys) {
    const re = new RegExp(`${prefix}${key}${sepRe}(.*)`, flags);
    const m = text.match(re);
    out[key] = m ? m[1].trim() : undefined;
  }
  return out;
}

export function parseDelimitedBlock(
  text: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const re = new RegExp(`${startMarker}\\s*\\n([\\s\\S]*?)\\n${endMarker}`, 'i');
  const m = text.match(re);
  return m ? m[1] : null;
}
