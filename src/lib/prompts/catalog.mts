// Enumeration of the prompt registry (CH-24, ARCH-28).
//
// WHAT WAS MISSING. `getPrompt(strategy, name)` answers "give me this one".
// Nothing answered "what is there" — the config was loaded, walked once at
// startup and only ever indexed. The costume needs the other direction: a
// third-party harness cannot be handed the METHOD if the method cannot be
// listed. This module reads the already-loaded, already-validated config and
// turns it into flat rows. No new disk access (`loadPromptsConfig` memoises),
// no new validation, no execution.
//
// SHAPE, NOT TEXT. A catalogue row carries the prompt's identity, kind,
// declared variables and whether it has an invariant system half. It does NOT
// carry the prompt text: text is what `getPrompt(...).build()` produces, under
// the registry's own rules (bundle overrides, A/B variants). Two readers, one
// source of truth.

import { loadPromptsConfig } from "./config.loader.mjs";
import { isSplitTemplateFile, type PromptEntry } from "./prompts.schema.mjs";

export interface PromptCatalogEntry {
  /** `<strategy>/<name>` — how the registry addresses it. */
  id: string;
  strategy: string;
  name: string;
  kind: PromptEntry["kind"];
  /** Declared `{{var}}` placeholders of the user half, in declaration order. */
  variables: readonly string[];
  /**
   * True when the prompt is a split `{ system, user }` pair. The system half is
   * invariant by contract (the loader hard-fails on a placeholder in it), which
   * is precisely what makes it publishable as METHOD rather than as one call's
   * phrasing.
   */
  hasSystemHalf: boolean;
  /** How the LLM response is read back. Informational — a harness that renders
   *  the prompt itself never runs the parser. */
  parserKind: PromptEntry["parser"]["kind"];
}

/**
 * Every prompt declared in `prompts.config.json`, sorted by id. Includes
 * `function`-kind entries: a catalogue that hid them would misrepresent the
 * registry. Selecting WHICH of them the MCP costume publishes is a delivery
 * decision, made in `src/mcp/prompt-registry.mts` against a stated criterion.
 */
export function listPromptCatalog(): PromptCatalogEntry[] {
  const loaded = loadPromptsConfig();
  const entries: PromptCatalogEntry[] = [];
  for (const [strategy, prompts] of Object.entries(loaded.config)) {
    for (const [name, entry] of Object.entries(prompts)) {
      entries.push({
        id: `${strategy}/${name}`,
        strategy,
        name,
        kind: entry.kind,
        variables: entry.kind === "template" ? entry.variables : [],
        hasSystemHalf: entry.kind === "template" && isSplitTemplateFile(entry.templateFile),
        parserKind: entry.parser.kind,
      });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

/** One catalogue row by id (`<strategy>/<name>`), or undefined. */
export function getPromptCatalogEntry(id: string): PromptCatalogEntry | undefined {
  return listPromptCatalog().find((e) => e.id === id);
}
