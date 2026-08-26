// The 5-segment grammar, AS DATA (CH-24, ARCH-28).
//
// WHY THIS FILE EXISTS. The grammar is already authoritative in prose —
// docs/architecture/ast-schema.md § 1.1, in French, 1500 lines, half of it
// Notion front-matter. That document is for the humans who build labre-mcp. A
// third-party harness that connects to the daemon needs the same rules in
// thirty machine-readable lines, in English, without the roadmap around them.
// This is that: the addressing rules a caller must obey to use `runCommand`,
// stated once, so `labre://grammar` never drifts from a hand-written copy.
//
// It is a CONSTANT. No disk, no cache, no computation — the grammar does not
// change between two calls, and the regex below is the very one the strategy
// registry validates against (imported, not re-typed).

import { METHOD_ID_5_SEGMENT_REGEX } from "../ast/base-strategy.mjs";

export interface GrammarSegment {
  position: 1 | 2 | 3 | 4 | 5;
  name: string;
  role: string;
  examples: string[];
}

export interface Grammar {
  version: string;
  pattern: string;
  /** Source form of the anchored regex the registry actually enforces. */
  regex: string;
  separator: string;
  segments: GrammarSegment[];
  rules: string[];
  discovery: string[];
}

export const GRAMMAR_VERSION = "0.1.0";

export const GRAMMAR: Grammar = {
  version: GRAMMAR_VERSION,
  pattern: "{domain}:{tool}:{sub-domain}:{command}:{strategy}[@x.y.z]",
  regex: METHOD_ID_5_SEGMENT_REGEX.source,
  separator: ":",
  segments: [
    {
      position: 1,
      name: "domain",
      role: "The framework a capability belongs to.",
      examples: ["wardley", "render", "common"],
    },
    {
      position: 2,
      name: "tool",
      role: "The business artefact or process inside that framework.",
      examples: ["map", "doctrine", "climate", "gameplay", "iteration", "owm", "image"],
    },
    {
      position: 3,
      name: "sub-domain",
      role: "The aspect of the tool the command operates on.",
      examples: ["value-chain", "evolution", "climate", "node", "output", "quality"],
    },
    {
      position: 4,
      name: "command",
      role: "The action applied to the sub-domain. The vocabulary is OPEN — new commands are added, never drawn from a fixed enum.",
      examples: ["generate", "parse", "emit", "audit", "identify", "estimate", "update", "read"],
    },
    {
      position: 5,
      name: "strategy",
      role: "Which implementation of the command runs. `default` is a strategy like any other, never implicit.",
      examples: ["default", "top-down", "s-curve", "llm-direct", "pipeline-opportunity"],
    },
  ],
  rules: [
    "Wire format is STRICTLY 5 segments. No segment may be omitted — including segment 5, where `default` must be written out.",
    "Each segment starts with a lowercase letter and contains lowercase alphanumerics or dashes.",
    "The `@x.y.z` SemVer triplet suffix is optional; omitted resolves to the latest stable version.",
    "No wildcard on the wire. Discovery goes through the catalogue, not through a special token.",
    "Cross-domain aliases are forbidden in v0.1.0 — bridges go explicitly through the `common` domain.",
    "A methodId is invoked directly with the `runCommand` tool: { command: \"<methodId>\", input: {...} }.",
    "A recipe orchestrates two or more commands and is invoked with `runRecipe` by its 3-segment ref `<domain>:<tool>:<name>`.",
  ],
  discovery: [
    "Read the resource `labre://methods` for the live catalogue with each methodId's implementation status.",
    "Or call the toolbox command `common:toolbox:list:emit:default` with { prefix: \"wardley:map:\" } to filter by prefix.",
  ],
};
