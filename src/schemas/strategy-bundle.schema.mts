// Strategy bundle manifest schema (v0).
//
// A strategy bundle is a DATA-ONLY package (no executable code) layering one
// recipe + optional prompt pairs on top of the shipped primitives:
//
//   <bundle-root>/
//     manifest.json                              ← validated by this schema
//     recipe.json                                ← exactly one recipe in v0
//     prompts/<strategyId>/<name>.system.md      ← optional, always split pairs
//     prompts/<strategyId>/<name>.user.md
//
// The manifest is the exchange contract between the loader (local dir today,
// Supabase-fetched later) and the admin frontend, which imports this module
// via the `@formicoidea/labre-mcp/schemas` export.

import { z } from 'zod';

/** Kebab-case bundle slug: `my-bundle-2`, never leading/trailing/double dash. */
export const BUNDLE_SLUG_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Simple SemVer `x.y.z` with optional prerelease suffix (no build metadata). */
const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// Prompt strategyIds and prompt names become directory / file name segments
// under prompts/ — restrict them to a filesystem-safe kebab/dotted subset
// (matches the shipped prompts.config.json key style, e.g. "cpc-mapper",
// "with-capability", "sot-extraction").
const PROMPT_SEGMENT_REGEX = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

const promptSegment = (label: string) =>
  z
    .string()
    .regex(
      PROMPT_SEGMENT_REGEX,
      `${label} must be a filesystem-safe kebab-case segment (e.g. "identify-capability")`,
    );

/** Capabilities a bundle's recipe may exercise at run time. */
export const BundlePermissionSchema = z.enum(['llm', 'bigquery', 'network', 'render']);

export const StrategyBundleManifestSchema = z
  .object({
    schemaVersion: z.literal('0.1'),
    slug: z
      .string()
      .regex(BUNDLE_SLUG_REGEX, 'slug must be kebab-case (e.g. "evaluate-map-example")'),
    version: z.string().regex(SEMVER_REGEX, 'version must be SemVer (e.g. "0.1.0")'),
    description: z.string().min(1, 'description must be a non-empty string'),
    // Duplicates are tolerated on input and deduplicated on parse — the
    // canonical (output) shape always carries each permission at most once.
    permissions: z
      .array(BundlePermissionSchema)
      .transform((perms) => [...new Set(perms)]),
    // strategyId → prompt names shipped as split pairs under prompts/.
    prompts: z
      .record(promptSegment('prompts strategyId'), z.array(promptSegment('prompt name')).min(1))
      .optional(),
  })
  .strict();

export type BundlePermission = z.infer<typeof BundlePermissionSchema>;
// z.output: `permissions` is post-dedup on the inferred type.
export type StrategyBundleManifest = z.output<typeof StrategyBundleManifestSchema>;
