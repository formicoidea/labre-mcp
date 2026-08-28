// The MCP delivery's RESOURCE composition — the KNOWLEDGE half of the costume
// (CH-24, ARCH-28).
//
// WHAT THIS FIXES. A harness that can call `runCommand` still cannot USE it
// without three things this repository knew and never published: how a methodId
// is spelled, which ones actually exist and which of those really compute, and
// what shape the data going in and out has. All three were documented — in a
// 1500-line French pivot document, in a directory of JSON Schemas reachable
// only over an HTTP path nobody advertises, and in a `recipes/` folder with no
// listing at all. These resources publish them at stable URIs.
//
// ── THE URI SCHEME ──────────────────────────────────────────────────────────
//
//     labre://<category>[/<id>]
//
//   labre://grammar            the 5-segment addressing rules (a constant)
//   labre://methods            the LIVE methodId catalogue, with per-entry
//                              implementation status (real / mock) and the
//                              reason any registered method refuses to run
//   labre://recipes            the shipped recipe catalogue, with each recipe's
//                              3-segment `runRecipe` ref and its steps
//   labre://schemas/<id>       one published JSON Schema, `<id>` being its file
//                              name without `.schema.json`
//
// Three rules the scheme obeys. (a) A URI is STABLE: it names a category, never
// a version or a path on disk, so a schema file moving or a strategy being
// promoted changes the content behind a URI and never the URI. (b) The
// `schemas/` category is the only one with an id segment, and its ids come from
// the shipped directory listing — no caller string is ever resolved into a
// path. (c) Nothing is parameterised: `resources/read` takes a URI and nothing
// else, because a resource that took arguments would be a tool wearing a URI
// (ARCH-28's data-only limit).
//
// ── SELECTION ───────────────────────────────────────────────────────────────
// The schema category is MECHANICAL — whatever `schema/` holds, which is
// already exactly what the daemon serves publicly on `GET /schemas/:file`. So
// the two surfaces cannot disagree, and a schema added by `pnpm schemas`
// appears with no second edit. The other three are one apiece: there is one
// grammar, one live catalogue, one shipped recipe set.

import { ResourceRegistry, type ResourceDefinition } from "#core/registry/resource-registry.mjs";
import type { StrategyRegistry } from "#core/registry/strategy-registry.mjs";
import type { BaseStrategy } from "#core/ast/base-strategy.mjs";
import { GRAMMAR, GRAMMAR_VERSION } from "#core/catalog/grammar.mjs";
import {
  listShippedRecipes,
  listShippedSchemas,
  readShippedSchema,
} from "#core/catalog/shipped-assets.mjs";
import { SHIPPED_ROOT } from "#core/shipped-root.mjs";
import { buildStrategyRegistry } from "#frameworks/registry-boot.mjs";

export const GRAMMAR_URI = "labre://grammar";
export const METHODS_URI = "labre://methods";
export const RECIPES_URI = "labre://recipes";
/** URI of one published schema. `id` comes from the shipped listing, never
 *  from a caller. */
export function schemaUri(id: string): string {
  return `labre://schemas/${id}`;
}

const JSON_MIME = "application/json";
const SCHEMA_MIME = "application/schema+json";

/** Pretty-printed: these are documents a human or a model reads, not a payload
 *  on a hot path. */
function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export interface McpResourceRegistryOptions {
  /**
   * The strategy catalogue `labre://methods` describes. The composition roots
   * pass the registry they already built, so the resource reports the SAME
   * catalogue the daemon will actually resolve against, fixtures included and
   * declared as such. Omitted → one is built lazily on first read.
   */
  strategies?: StrategyRegistry<BaseStrategy>;
  /** Where this package's `schema/` and `recipes/` live. Injectable for tests. */
  shippedRoot?: string;
}

/** Compose the costume's resource surface. Called by the composition roots. */
export async function buildMcpResourceRegistry(
  options: McpResourceRegistryOptions = {},
): Promise<ResourceRegistry> {
  const shippedRoot = options.shippedRoot ?? SHIPPED_ROOT;
  const registry = new ResourceRegistry();

  // The strategy catalogue is read at every `resources/read` rather than
  // snapshotted here: registries are filled at boot and never mutate, but
  // reading through keeps this resource honest if that ever changes.
  let strategies = options.strategies;
  const getStrategies = (): StrategyRegistry<BaseStrategy> => {
    strategies ??= buildStrategyRegistry();
    return strategies;
  };

  const entries: ResourceDefinition[] = [
    {
      uri: GRAMMAR_URI,
      name: "grammar",
      title: "The 5-segment methodId grammar",
      description:
        "How every capability of this server is addressed: the five segments, what each one " +
        "means, the anchored regex the registry enforces, and the rules a caller must obey " +
        "(no wildcards, no implicit `default`, no cross-domain aliases). Read this before " +
        "calling runCommand.",
      mimeType: JSON_MIME,
      async read() {
        return toJson(GRAMMAR);
      },
    },
    {
      uri: METHODS_URI,
      name: "methods",
      title: "Live methodId catalogue",
      description:
        "Every methodId this daemon has registered, each marked `real` (it computes) or " +
        "`mock` (it answers deterministic scaffold data describing the future contract, not " +
        "your map), plus the reason any registered method refuses to run. Check the status " +
        "before trusting an answer.",
      mimeType: JSON_MIME,
      async read() {
        const catalogue = getStrategies().catalogue();
        return toJson({
          grammarVersion: GRAMMAR_VERSION,
          invokeWith: 'runCommand { command: "<methodId>", input: { ... } }',
          counts: {
            total: catalogue.length,
            real: catalogue.filter((e) => e.implementation === "real").length,
            mock: catalogue.filter((e) => e.implementation === "mock").length,
            disabled: catalogue.filter((e) => e.disabledReason !== undefined).length,
          },
          methods: catalogue,
        });
      },
    },
    {
      uri: RECIPES_URI,
      name: "recipes",
      title: "Shipped recipe catalogue",
      description:
        "The multi-step flows this package ships, each with the 3-segment ref runRecipe " +
        "takes and the methodIds it orchestrates. Per-project overrides are deliberately " +
        "absent: this lists what the package guarantees.",
      mimeType: JSON_MIME,
      async read() {
        const recipes = await listShippedRecipes(shippedRoot);
        return toJson({
          count: recipes.length,
          invokeWith: 'runRecipe { recipe: "<domain>:<tool>:<name>", input: { ... } }',
          recipes,
        });
      },
    },
  ];

  for (const schema of await listShippedSchemas(shippedRoot)) {
    entries.push({
      uri: schemaUri(schema.id),
      name: `schema:${schema.id}`,
      title: `JSON Schema — ${schema.id}`,
      description: `The published \`${schema.fileName}\` contract.`,
      mimeType: SCHEMA_MIME,
      async read() {
        return readShippedSchema(shippedRoot, schema.id);
      },
    });
  }

  for (const entry of entries) registry.register(entry);
  return registry;
}
