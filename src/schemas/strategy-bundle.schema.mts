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

export const StrategyBundleManifestSchema = z
  .object({
    schemaVersion: z.literal('0.1'),
    slug: z
      .string()
      .regex(BUNDLE_SLUG_REGEX, 'slug must be kebab-case (e.g. "evaluate-map-example")'),
    version: z.string().regex(SEMVER_REGEX, 'version must be SemVer (e.g. "0.1.0")'),
    description: z.string().min(1, 'description must be a non-empty string'),
    // DELETED, not enforced — ARCH-29 A4 (arbitrated 2026-08-28). This was
    // `('llm'|'bigquery'|'network'|'render')[]`, read in exactly ONE place to
    // check that a bundle declaring prompts also declared `llm`. Nothing ever
    // enforced `network`. On an inert payload that is harmless; on anything
    // else it is misdirection, and the ADR requires it enforced or gone.
    //
    // It is still ACCEPTED and DISCARDED rather than simply removed: this
    // object is `.strict()`, so dropping the key outright would reject every
    // manifest already published against v0.1 — including the rows in
    // `strategy_bundles`. Accepting and stripping it deletes the CONCEPT (no
    // consumer can read it, it is absent from the output type) without
    // bricking deployed data.
    permissions: z.unknown().optional(),
    // RESERVED — ARCH-29 A5. Optional, never read, and NOT a control: the
    // trust anchor today is the `service_role`-write-only row plus per-file
    // sha256, not a key. Declared now only because the object is `.strict()`,
    // so a field added later would be rejected by every daemon deployed until
    // then. Reserving it costs one line and removes a future breaking change.
    // Do not verify it, and do not describe it as a signature check, until an
    // ADR says what signs it and who holds the key.
    signature: z.string().optional(),
    // strategyId → prompt names shipped as split pairs under prompts/.
    prompts: z
      .record(promptSegment('prompts strategyId'), z.array(promptSegment('prompt name')).min(1))
      .optional(),
  })
  .strict()
  // Strips the accepted-but-deleted `permissions` key, so it is absent from the
  // output type and unreachable from any consumer (ARCH-29 A4).
  .transform(({ permissions: _deleted, ...manifest }) => manifest);

// z.output: `permissions` is stripped; `signature` is reserved and unread.
export type StrategyBundleManifest = z.output<typeof StrategyBundleManifestSchema>;
