// Registry of code-resident LLM response parsers for `parser.kind: custom`
// entries. Parsers decode the raw LLM response into a domain-specific object.
//
// Modules that own parsers call registerParser() at import time. The registry
// lookup happens inside getPrompt() when `parser.kind === 'custom'`.
//
// For generic shapes, prompts.config.json can also use `kind: keyValue` or
// `kind: delimited` — those are resolved directly by the registry without a
// custom registration (see registry.mts).

// any: parsers accept arbitrary context and return arbitrary shapes
export type PromptParser = (response: string, ctx?: any) => any;

const parsers = new Map<string, PromptParser>();

export function registerParser(id: string, fn: PromptParser): void {
  if (parsers.has(id)) {
    throw new Error(`Prompt parser "${id}" is already registered`);
  }
  parsers.set(id, fn);
}

export function getParser(id: string): PromptParser | undefined {
  return parsers.get(id);
}

export function hasParser(id: string): boolean {
  return parsers.has(id);
}

/** Test-only */
export function resetParsersRegistry(): void {
  parsers.clear();
}
