// Overridability check for bundle-shipped prompt pairs.
//
// v1 rule: a bundle may only SHADOW a shipped `template`-kind prompt. Rationale
// — strategies call getPrompt() with hardcoded (strategyId, name) ids, so an
// override targeting an id that ships no prompt would be unreachable (nothing
// asks for it), and a `function`-kind entry builds its text from a registered
// builder the bundle cannot supply. Rather than register a silently-inert
// override, we fail the whole bundle load with a clear reason. The prompt
// registry's run-scoped override path (registry.mts) reuses the shipped entry's
// parser, which is why the shipped entry must exist to be overridden at all.

import { loadPromptsConfig } from './config.loader.mjs';
import type { BundlePromptPair } from './override-context.mjs';

/**
 * Assert every declared (strategyId, name) override targets a shipped
 * `template`-kind prompt. Throws — naming the bundle `label`, the offending
 * pair, and the reason — on the first violation:
 *   - unknown prompt: no shipped entry for (strategyId, name);
 *   - function-kind: the shipped entry exists but is `function`-kind (its text
 *     comes from a builder the bundle cannot override).
 * A `prompts` value of `{}` (no declared overrides) passes trivially.
 */
export function assertBundlePromptsOverridable(
  prompts: Record<string, Record<string, BundlePromptPair>>,
  label: string,
): void {
  const shipped = loadPromptsConfig().config;
  for (const [strategyId, byName] of Object.entries(prompts)) {
    for (const name of Object.keys(byName)) {
      const entry = shipped[strategyId]?.[name];
      if (!entry) {
        throw new Error(
          `Bundle ${label}: prompt "${strategyId}/${name}" overrides an unknown shipped prompt ` +
            `(no entry in prompts.config.json). A bundle may only shadow an existing shipped ` +
            `template prompt — strategies request prompts by hardcoded id, so this override ` +
            `would never be reached.`,
        );
      }
      if (entry.kind !== 'template') {
        throw new Error(
          `Bundle ${label}: prompt "${strategyId}/${name}" overrides a "${entry.kind}"-kind shipped ` +
            `prompt, which is not overridable. Only "template"-kind prompts can be shadowed ` +
            `(a "function"-kind prompt builds its text from a registered builder the bundle ` +
            `cannot supply).`,
        );
      }
    }
  }
}
