// A recipe is a declarative quasi-linear DAG of strategy invocations operating
// on a single tool's AST (ARCH-06). Recipes are not parameterisable (ARCH-07);
// behavioural variation comes from listener strategies attached to the same
// recipe (ARCH-10). A recipe never invokes another recipe.

import { z } from "zod";
import { methodIdSchema } from "../ast/base-strategy.mjs";

// Each step references a strategy by its 5-segment methodId. Optional `over`
// path triggers auto-fanout: when the strategy expects T and the AST node at
// `over` is T[], the runner runs the strategy once per element in parallel.
// `in` and `out` paths bind step input/output to specific AST locations
// (explicit linking — ARCH-3B-1).
export const RecipeStepSchema = z.object({
  stepId: z.string().min(1),
  tool: methodIdSchema, // 5-segment methodId, also resolved against the registry at run time
  in: z.string().optional(), // JSONPath into the current AST (default: whole AST)
  out: z.string().optional(), // JSONPath where to write the result (default: $.lastResult)
  over: z.string().optional(), // JSONPath; if present, fan out across the array
});
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const RecipeSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    name: z.string().min(1), // canonical name e.g. "evaluate-map"
    domain: z.string().min(1), // e.g. "wardley"
    tool: z.string().min(1), // e.g. "evolution"
    description: z.string().optional(),
    steps: z.array(RecipeStepSchema).min(1),
    // Listeners are step-attached: each key is a stepId of `steps`, mapped to
    // the 5-segment methodIds of the listener strategies observing that step.
    // They run after the main path completes, in parallel, and only contribute
    // insights to the envelope (ARCH-10) — see recipe-runner.
    listeners: z.record(z.string(), z.array(methodIdSchema)).default({}),
  })
  .superRefine((recipe, ctx) => {
    // A listener can only attach to a step that exists in this recipe.
    const stepIds = new Set(recipe.steps.map((s) => s.stepId));
    for (const stepId of Object.keys(recipe.listeners)) {
      if (!stepIds.has(stepId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["listeners", stepId],
          message: `listeners key "${stepId}" does not match any step.stepId (${[...stepIds].join(", ")})`,
        });
      }
    }
  });
export type Recipe = z.infer<typeof RecipeSchema>;
