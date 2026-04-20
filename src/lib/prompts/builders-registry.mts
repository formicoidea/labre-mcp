// Registry of code-resident prompt builders for `kind: function` entries.
//
// Builders are functions that assemble a prompt string from a structured
// context object (for cases too complex for static {{var}} templates — loops
// over property lists, conditional blocks, pre-formatted sub-sections, etc.).
//
// Modules that own the builders call registerBuilder() at import time. The
// config loader references them by the `builderId` field in prompts.config.json.

// any: builders receive arbitrary context shapes and return a prompt string
export type PromptBuilder = (ctx: any) => string;

const builders = new Map<string, PromptBuilder>();

export function registerBuilder(id: string, fn: PromptBuilder): void {
  if (builders.has(id)) {
    throw new Error(`Prompt builder "${id}" is already registered`);
  }
  builders.set(id, fn);
}

export function getBuilder(id: string): PromptBuilder | undefined {
  return builders.get(id);
}

export function hasBuilder(id: string): boolean {
  return builders.has(id);
}

/** Test-only */
export function resetBuildersRegistry(): void {
  builders.clear();
}
