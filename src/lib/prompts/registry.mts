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

import { loadPromptsConfig } from './config.loader.mjs';
import { interpolate } from './interpolate.mjs';
import { parseDelimitedBlock } from './parsers.mjs';
import { getBuilder } from './builders-registry.mjs';
import { getParser } from './parsers-registry.mjs';

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

export function getPrompt(strategy: string, name: string = 'default'): ResolvedPrompt {
  const key = cacheKey(strategy, name);
  const hit = cache.get(key);
  if (hit) return hit;

  const loaded = loadPromptsConfig();
  const entry = loaded.config[strategy]?.[name];
  if (!entry) {
    throw new Error(`Prompt "${strategy}/${name}" not found in prompts.config.json`);
  }

  let build: (varsOrCtx: any) => BuiltPrompt;
  if (entry.kind === 'template') {
    const template = loaded.templates[strategy]?.[name];
    if (!template) {
      // Defensive — the loader populates templates for every template-kind entry.
      throw new Error(`Prompt "${strategy}/${name}": template not loaded`);
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
        `Prompt "${strategy}/${name}": builder "${entry.builderId}" is not registered. ` +
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
        `Prompt "${strategy}/${name}": builder "${entry.builderId}" returned an invalid shape ` +
        `(expected string or { system?, user: string })`,
      );
    };
  }

  const p = entry.parser;
  // Parser resolution is lazy: call-sites that only need build() should not
  // require parser registration. Errors surface on first parse() call instead.
  let parse: (response: string, ctx?: any) => any;
  if (p.kind === 'custom') {
    parse = (response: string, ctx?: any) => {
      const fn = getParser(p.id);
      if (!fn) {
        throw new Error(
          `Prompt "${strategy}/${name}": parser "${p.id}" is not registered. ` +
          `Call registerParser("${p.id}", fn) before .parse().`,
        );
      }
      return fn(response, ctx);
    };
  } else if (p.kind === 'delimited') {
    parse = (response: string) => parseDelimitedBlock(response, p.startMarker, p.endMarker);
  } else {
    // keyValue — reserved for future generic prompts. Current codebase uses
    // custom parsers everywhere (each has domain-specific post-processing).
    parse = () => {
      throw new Error(
        `Prompt "${strategy}/${name}": parser kind "keyValue" requires a schema registry, ` +
        `not yet wired. Use kind=custom with a registered parser instead.`,
      );
    };
  }

  const resolved: ResolvedPrompt = { build, parse };
  cache.set(key, resolved);
  return resolved;
}

/** Test-only */
export function resetPromptRegistryCache(): void {
  cache.clear();
}
