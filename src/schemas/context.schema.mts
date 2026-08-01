// Zod schema for a Wardley study `Context` — the output of
// `wardley:iteration:purpose:generate:default` and the input of
// `wardley:iteration:purpose:audit-purpose-quality:default` (ast-schema.md
// v0.1.0 § iteration/purpose).
//
// The ast-schema envelope.context lists { purpose/title, scope, angle,
// temporality, granularity, deliverables }. Two more fields — `raisonDetre`
// and `problematisation` — carry the pieces the quality audit needs: the
// pedagogical "présent idéal" framework (Notion — Étape n°1 : le jeu) frames a
// good purpose as a coherent chain raison d'être → contexte → objectif →
// problématisation, and the audit cannot judge that coherence without them.
//
// Every field is optional-with-default so a partially-formed Context still
// validates — the audit's whole job is to report what is missing or weak, so
// it must accept an incomplete purpose rather than reject it at the boundary.

import { z } from 'zod';
import { TemporalitySchema } from './value-chain.schema.mjs';

export const PurposeContextSchema = z
  .object({
    // The intermediate objective / title of the study (the map's subject).
    title: z.string().default(''),
    // The user's original verbatim prompt/brief — the human's request, NOT the
    // calling agent's reformulation. Unstructured source the structured fields
    // were distilled from; passed through untouched by purpose:generate (never
    // LLM-generated), so the audit can judge the extraction against the original.
    prompt: z.string().default(''),
    // Tangible, easy-to-understand boundary of the study (Wardley: "le champ
    // d'application doit être tangible et facile à comprendre").
    scope: z.string().default(''),
    // The lens / question the study is framed through.
    angle: z.string().default(''),
    temporality: TemporalitySchema.default('present'),
    // Coarseness of the intended map (org-wide vs a single capability, …).
    granularity: z.string().default(''),
    // Concrete outputs the study should produce.
    deliverables: z.array(z.string()).default([]),
    // Long-term reason-for-being that anchors and legitimises the objective.
    raisonDetre: z.string().default(''),
    // The study question the purpose opens onto (every worked example in the
    // course ends on one).
    problematisation: z.string().default(''),
  })
  .strict();

export type PurposeContext = z.infer<typeof PurposeContextSchema>;
