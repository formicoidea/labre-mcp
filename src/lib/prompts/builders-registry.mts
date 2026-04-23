// Registry of code-resident prompt builders for `kind: function` entries.
//
// Builders are functions that assemble a prompt from a structured context
// object (for cases too complex for static {{var}} templates — loops over
// property lists, conditional blocks, pre-formatted sub-sections, etc.).
//
// A builder may return either:
//   - a string (legacy: treated as the user message, no system prompt)
//   - an object { system?: string, user: string } (preferred: exploits the
//     SDK-level systemPrompt channel cleanly)
//
// Modules that own the builders call registerBuilder() at import time. The
// config loader references them by the `builderId` field in prompts.config.json.

/** Structured output for builders that want to emit a system/user split. */
export interface BuilderOutput {
  system?: string;
  user: string;
}

// any: builders receive arbitrary context shapes.
export type PromptBuilder = (ctx: any) => string | BuilderOutput;

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
