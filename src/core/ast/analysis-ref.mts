// AnalysisRef — typed pointer from a chain `EvolutionAnnotation` to the
// richer `WardleyEvolutionAST` artefact it was derived from (ARCH-24).
//
// `artifactPath` is the artefact filename written by the artifact-writer
// listener (relative to the run's artifact dir, or absolute). `jsonPath` is
// an optional JSONPath into that artefact pointing to the specific node the
// annotation summarises (`$.result` by default when omitted).
//
// Null means "no detailed analysis was produced" — the annotation stands on
// its own (e.g. when only a deterministic strategy ran and the trace would
// be redundant with the annotation itself).

import { z } from "zod";

export const AnalysisRefSchema = z
  .object({
    artifactPath: z.string().min(1),
    jsonPath: z.string().optional(),
  })
  .nullable();

export type AnalysisRef = z.infer<typeof AnalysisRefSchema>;
