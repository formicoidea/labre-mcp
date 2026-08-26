// The MCP delivery's PROMPT composition — the METHOD half of the costume
// (CH-24, ARCH-28).
//
// WHAT THIS FIXES. Until now a third-party harness that connected to this
// daemon saw six executable tools and nothing else. It could RUN the framework
// and could not LEARN it: the method — how a Wardley practitioner decides what
// a component's underlying capability is, how an anchor is placed in evolution,
// how a value chain is built top-down — sat in `prompts/*.system.md`, reachable
// only from inside a strategy's own LLM call. These prompts hand that method
// over as text the harness can read, adapt and run on its own model.
//
// ── THE SELECTION CRITERION ─────────────────────────────────────────────────
// The registry holds ~20 prompts. Publishing all of them would be a dump, and
// most would be noise or worse — a caller cannot usefully be handed the prompt
// that maps a capability onto a CPC patent class. A prompt enters the costume
// when ALL FOUR hold:
//
//   1. TEMPLATE KIND. It is declared `kind: "template"`, i.e. it IS data — two
//      markdown files this package ships. A `function`-kind builder is code,
//      and the costume is data-only until C4 (ARCH-28).
//   2. SPLIT PAIR. It has an invariant `{ system, user }` half. The system half
//      is the METHOD (the loader hard-fails if it carries a placeholder); a
//      monolithic legacy prompt has no method to hand over, only one call's
//      phrasing.
//   3. METHOD, NOT MACHINERY. It instructs a framework judgement a practitioner
//      would recognise — identify a capability, anchor an evolution, write a
//      chain — rather than serving an internal pipeline mechanism. This is what
//      excludes cpc-mapper (patent-class routing), logprob-fallback (a
//      provider workaround), solution-classification and pipeline-enrichment
//      (enrichment plumbing), render-image-parse-png and render-text-lint (I/O
//      adapters).
//   4. CALLER-SUPPLIABLE VARIABLES. Every declared variable is something a
//      third party can actually produce. This is what excludes
//      timeline-benchmark (`history_section`, `pacing_guidance` are computed
//      upstream), properties-strategy (`property_block`, `format_lines`) and
//      cpc-mapper's `codes_list`.
//
// Six prompts pass. The list is deliberately short and is pinned in both
// directions by costume-parity.test.mts — a seventh cannot appear unnoticed,
// and one of these six cannot vanish silently either.
//
// ── REQUIRED VS OPTIONAL ────────────────────────────────────────────────────
// The prompt registry's own interpolation contract substitutes an EMPTY string
// for an absent variable, so strictly nothing is required. That would be a
// useless thing to tell a harness. The rule applied here: the prompt's PRIMARY
// SUBJECT is required — the thing without which the prompt is about nothing —
// and every qualifier around it (description, context, date) is optional and
// interpolates empty. A missing required argument is refused at the dispatch
// with InvalidParams rather than rendered into a prompt about nothing.
//
// ── HOW A PROMPT IS RENDERED ────────────────────────────────────────────────
// MCP prompt messages carry no `system` role. The invariant system half is
// therefore emitted as the FIRST user message and the interpolated user half
// as the second, which is the shape a client can paste straight into any
// provider. Rendering goes through `getPrompt(...).build()` rather than
// re-reading the files, so a bundle override or an active A/B variant is
// honoured here exactly as it is inside a strategy — one source of truth, two
// readers.

import {
  PromptRegistry,
  requireArguments,
  type PromptArgumentDefinition,
  type PromptDefinition,
} from "#core/registry/prompt-registry.mjs";
import { getPromptCatalogEntry } from "#lib/prompts/catalog.mjs";
import { getPrompt } from "#lib/prompts/registry.mjs";

/** One published prompt, declared against the registry entry it publishes. */
interface CostumePromptDeclaration {
  /** MCP name. Kept to `^[a-zA-Z0-9_-]{1,64}$` (hard rule #24b): `<strategy>`
   *  for a `default` entry, `<strategy>__<name>` otherwise. No dots — a single
   *  invalid name makes claude.ai reject a whole conversation's request. */
  name: string;
  /** Registry address: `<strategy>/<name>` in prompts.config.json. */
  promptId: string;
  title: string;
  description: string;
  /** The primary subject — the one variable that must be supplied. */
  required: string;
  /** Per-variable help. Every declared variable of the entry must appear. */
  help: Record<string, string>;
}

/** THE COSTUME'S PROMPT LIST. Six entries, one criterion (see header). */
export const COSTUME_PROMPTS: readonly CostumePromptDeclaration[] = [
  {
    name: "identify-capability",
    promptId: "identify-capability/default",
    title: "Identify a component's underlying capability",
    description:
      "Wardley method: name the generic capability a named component actually provides, " +
      "separating the capability from the solution that implements it. This is the step " +
      "that makes two differently-named components comparable on a map.",
    required: "component",
    help: {
      component: "The component's name, as it appears on the map.",
      description: "What the component does, in one or two sentences. Optional.",
      context: "The business environment the map describes. Optional but improves accuracy.",
    },
  },
  {
    name: "anchor-evolution",
    promptId: "anchor-evolution/default",
    title: "Position the anchor in evolution",
    description:
      "Wardley method: place the map's anchor (the user need) on the evolution axis. " +
      "The anchor sets the frame every component below it is read against.",
    required: "anchor",
    help: {
      anchor: "The user need the map is anchored on.",
      context: "The business environment the map describes. Optional.",
    },
  },
  {
    name: "historical-evolution__with-capability",
    promptId: "historical-evolution/with-capability",
    title: "Place a capability in evolution from its history",
    description:
      "Wardley method: reason from a capability's real history — when it appeared, how it " +
      "spread, how it became ordinary — to place it on the evolution axis. Use it when the " +
      "component's underlying capability is already known (see identify-capability).",
    required: "capability",
    help: {
      capability: "The generic capability to place.",
      description: "What the capability covers. Optional.",
      context: "The business environment the map describes. Optional.",
      date: "The date the reasoning should consider 'today' (ISO). Optional.",
    },
  },
  {
    name: "publication-analysis",
    promptId: "publication-analysis/default",
    title: "Estimate evolution from publication signals",
    description:
      "Wardley method: read a component's evolution from the shape of what has been written " +
      "about it — how publications about it shift from speculation to construction to routine " +
      "operation. An independent second opinion on a placement, not a replacement for it.",
    required: "component",
    help: {
      component: "The component to analyse.",
      description: "What the component does. Optional.",
      context: "The business environment the map describes. Optional.",
    },
  },
  {
    name: "write-chain__top-down",
    promptId: "write-chain/top-down",
    title: "Write a value chain top-down",
    description:
      "Wardley method: build a value chain in the canonical order — anchor, then user needs, " +
      "then the capabilities those needs rest on, then the dependency links. The generation " +
      "instruction behind the generateValueChain tool.",
    required: "metadata",
    help: {
      metadata:
        "The study's metadata as JSON — at least the anchor and the organisation or " +
        "archetype the chain describes. A structured value is JSON-encoded for you.",
      date: "The date the reasoning should consider 'today' (ISO). Optional.",
    },
  },
  {
    name: "purpose-generate",
    promptId: "purpose-generate/default",
    title: "Formulate the purpose of a study",
    description:
      "Wardley method: turn a rough brief into an explicit purpose — scope, angle, " +
      "temporality, granularity, deliverables. The step before a map is worth drawing.",
    required: "topic",
    help: {
      topic: "What the study is about.",
      intent: "What the study is meant to decide or change. Optional.",
    },
  },
];

/**
 * Turn one declaration into a `PromptDefinition`, checking it against the
 * registry it claims to publish. The checks are deliberately hard failures at
 * BOOT: a costume entry that names a prompt the registry does not hold, or that
 * forgets to document a variable, is a broken promise to every client that
 * lists it — better a daemon that refuses to start than a surface that lies.
 */
function toDefinition(declaration: CostumePromptDeclaration): PromptDefinition {
  const entry = getPromptCatalogEntry(declaration.promptId);
  if (!entry) {
    throw new Error(
      `Costume prompt "${declaration.name}": no registry entry "${declaration.promptId}"`,
    );
  }
  // Criteria 1 and 2, enforced rather than trusted.
  if (entry.kind !== "template" || !entry.hasSystemHalf) {
    throw new Error(
      `Costume prompt "${declaration.name}": "${declaration.promptId}" is not a split template pair ` +
        `(kind=${entry.kind}, hasSystemHalf=${entry.hasSystemHalf}) — see the selection criterion`,
    );
  }
  const undocumented = entry.variables.filter((v) => declaration.help[v] === undefined);
  if (undocumented.length > 0) {
    throw new Error(
      `Costume prompt "${declaration.name}": variables ${JSON.stringify(undocumented)} have no help text`,
    );
  }
  if (!entry.variables.includes(declaration.required)) {
    throw new Error(
      `Costume prompt "${declaration.name}": required variable "${declaration.required}" is not declared by "${declaration.promptId}"`,
    );
  }

  const args: PromptArgumentDefinition[] = entry.variables.map((name) => ({
    name,
    description: declaration.help[name] as string,
    required: name === declaration.required,
  }));

  return {
    name: declaration.name,
    title: declaration.title,
    description: declaration.description,
    arguments: args,
    render(supplied) {
      requireArguments(declaration.name, args, supplied);
      // Through the registry, not around it: bundle overrides and A/B variants
      // apply here exactly as they do inside a strategy.
      const built = getPrompt(entry.strategy, entry.name).build(supplied);
      // MCP prompt messages have no `system` role — the invariant half leads as
      // the first user message.
      return built.system !== undefined
        ? [
            { role: "user", text: built.system },
            { role: "user", text: built.user },
          ]
        : [{ role: "user", text: built.user }];
    },
  };
}

/** Compose the costume's prompt surface. Called by the composition roots. */
export function buildMcpPromptRegistry(): PromptRegistry {
  const registry = new PromptRegistry();
  for (const declaration of COSTUME_PROMPTS) {
    registry.register(toDefinition(declaration));
  }
  return registry;
}
