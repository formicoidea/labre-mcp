// Prompt registry entry point.
//
// getPrompt(strategy, name?) returns a { build, parse } pair that wraps a
// prompt declared in prompts.config.json:
//   - build(vars) → BuiltPrompt { system?, user } — user text is always
//     produced (interpolation or builder output); system is present only when
//     the underlying prompt declares it (split template or builder-emitted).
//   - parse(response, ctx?) → domain-specific result (custom parser, keyValue
//     schema, or delimited-block extraction)
//
// The registry is lazy: template text is read once by the config loader and
// cached; each getPrompt() instance is cached by `${strategy}:${name}`.

import { loadPromptsConfig, type LoadedPrompts } from './config.loader.mjs';
import { interpolate } from './interpolate.mjs';
import { parseDelimitedBlock } from './parsers.mjs';
import { getBuilder } from './builders-registry.mjs';
import { getParser } from './parsers-registry.mjs';
import { getCurrentPromptOverrides } from './override-context.mjs';
import type { PromptEntry } from './prompts.schema.mjs';

/** Output of build(): a user message (always) and an optional system message.
 *  Callers that need a single string should concatenate them explicitly. */
export interface BuiltPrompt {
  system?: string;
  user: string;
}

// any: build accepts arbitrary var shapes (string map or builder ctx);
// parse returns arbitrary shapes decided by the registered parser.
export interface ResolvedPrompt {
  build(varsOrCtx: any): BuiltPrompt;
  parse(response: string, ctx?: any): any;
}

const cache = new Map<string, ResolvedPrompt>();

function cacheKey(strategy: string, name: string): string {
  return `${strategy}:${name}`;
}

// Build the parse() function for a resolved prompt from its parser config.
// Parser resolution is lazy: call-sites that only need build() should not
// require parser registration. Errors surface on first parse() call instead.
// Shared between the shipped-config path and the run-scoped override path — an
// override supplies prompt TEXT only, its parser always comes from the shipped
// entry (trust boundary: a bundle never selects a parser id).
function buildParse(
  strategy: string,
  name: string,
  p: PromptEntry['parser'],
): (response: string, ctx?: any) => any {
  if (p.kind === 'custom') {
    return (response: string, ctx?: any) => {
      const fn = getParser(p.id);
      if (!fn) {
        throw new Error(
          `Prompt "${strategy}/${name}": parser "${p.id}" is not registered. ` +
          `Call registerParser("${p.id}", fn) before .parse().`,
        );
      }
      return fn(response, ctx);
    };
  }
  if (p.kind === 'delimited') {
    return (response: string) => parseDelimitedBlock(response, p.startMarker, p.endMarker);
  }
  // keyValue — reserved for future generic prompts. Current codebase uses
  // custom parsers everywhere (each has domain-specific post-processing).
  return () => {
    throw new Error(
      `Prompt "${strategy}/${name}": parser kind "keyValue" requires a schema registry, ` +
      `not yet wired. Use kind=custom with a registered parser instead.`,
    );
  };
}

// Resolve a run-scoped override prompt: build() interpolates the bundle's user
// text (mirroring the template branch) with the invariant system attached
// verbatim; parse() comes from the SHIPPED entry. Never cached — the override
// is per-run content and must not poison the module-global cache.
function resolveOverride(
  strategy: string,
  name: string,
  pair: { system: string; user: string },
  loaded: LoadedPrompts,
): ResolvedPrompt {
  const shipped = loaded.config[strategy]?.[name];
  if (!shipped) {
    // Same trust boundary as the shipped path: a bundle supplies text only, so
    // parser selection must exist shipped-side. No shipped entry → not found.
    throw new Error(`Prompt "${strategy}/${name}" not found in prompts.config.json`);
  }
  const userText = pair.user;
  const systemText = pair.system;
  const build = (vars: any): BuiltPrompt => {
    const user = interpolate(userText, vars as Record<string, string>);
    return { system: systemText, user };
  };
  const parse = buildParse(strategy, name, shipped.parser);
  return { build, parse };
}

export function getPrompt(strategy: string, name: string = 'default'): ResolvedPrompt {
  const overrides = getCurrentPromptOverrides();

  // Prompt-experiment variant substitution (A/B testing): when the caller asks
  // for the DEFAULT prompt and an active variant is selected for this strategy,
  // redirect resolution to the variant name INSTEAD of 'default'. A variant only
  // ever redirects the default prompt — explicit non-default names (e.g.
  // cpc-mapper 'pick-class') are never substituted. If the variant name resolves
  // NOWHERE (neither a bundle override nor a shipped entry), fall back to
  // 'default' exactly as if no variant were active — fail-safe, mirroring the
  // PostHog fail-open contract: a flag naming a nonexistent prompt must never
  // break a run.
  let effectiveName = name;
  const variantName = name === 'default' ? overrides?.activeVariants?.[strategy] : undefined;
  if (variantName !== undefined && variantName !== 'default') {
    const loaded = loadPromptsConfig();
    const variantExists =
      overrides?.prompts[strategy]?.[variantName] !== undefined ||
      loaded.config[strategy]?.[variantName] !== undefined;
    if (variantExists) effectiveName = variantName;
  }

  // Run-scoped override branch: consult the ALS store BEFORE the cache. A
  // matching pair shadows the shipped prompt for this call tree only; the
  // result is never cached (would poison the global cache with run content).
  const overridePair = overrides?.prompts[strategy]?.[effectiveName];
  if (overridePair) {
    return resolveOverride(strategy, effectiveName, overridePair, loadPromptsConfig());
  }

  const key = cacheKey(strategy, effectiveName);
  const hit = cache.get(key);
  if (hit) return hit;

  const loaded = loadPromptsConfig();
  const entry = loaded.config[strategy]?.[effectiveName];
  if (!entry) {
    throw new Error(`Prompt "${strategy}/${effectiveName}" not found in prompts.config.json`);
  }

  let build: (varsOrCtx: any) => BuiltPrompt;
  if (entry.kind === 'template') {
    const template = loaded.templates[strategy]?.[effectiveName];
    if (!template) {
      // Defensive — the loader populates templates for every template-kind entry.
      throw new Error(`Prompt "${strategy}/${effectiveName}": template not loaded`);
    }
    const userText = template.text;
    const systemText = template.system;
    build = (vars: any): BuiltPrompt => {
      const user = interpolate(userText, vars as Record<string, string>);
      return systemText !== undefined ? { system: systemText, user } : { user };
    };
  } else {
    // kind === 'function'
    // Function builders may return either a legacy string (interpreted as
    // user-only) or a structured { system?, user } object. Both are accepted
    // so strategies can migrate incrementally.
    const fn = getBuilder(entry.builderId);
    if (!fn) {
      throw new Error(
        `Prompt "${strategy}/${effectiveName}": builder "${entry.builderId}" is not registered. ` +
        `Call registerBuilder("${entry.builderId}", fn) before getPrompt().`,
      );
    }
    build = (ctx: any): BuiltPrompt => {
      const out = fn(ctx);
      if (typeof out === 'string') return { user: out };
      if (out && typeof out === 'object' && typeof out.user === 'string') {
        return out.system !== undefined ? { system: out.system, user: out.user } : { user: out.user };
      }
      throw new Error(
        `Prompt "${strategy}/${effectiveName}": builder "${entry.builderId}" returned an invalid shape ` +
        `(expected string or { system?, user: string })`,
      );
    };
  }

  const parse = buildParse(strategy, effectiveName, entry.parser);

  const resolved: ResolvedPrompt = { build, parse };
  cache.set(key, resolved);
  return resolved;
}

/** Test-only */
export function resetPromptRegistryCache(): void {
  cache.clear();
}
