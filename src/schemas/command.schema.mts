// Zod schemas for the direct command-invocation envelopes (ast-schema.md § 3.4.1).
//
// `CommandCall` addresses a single strategy by its 5-segment methodId and
// carries its input. `CommandResult` wraps the strategy's canonical output
// together with the JSON-labre envelope (signals / reasoning / insights /
// trace) assembled by the runner. These formalise what was doc-only until now
// and back the `runCommand` MCP tool.

import { z } from 'zod';
import { methodIdSchema } from '#core/ast/base-strategy.mjs';

// --- CommandCall (input envelope) -----------------------------------------

export const CommandCallSchema = z
  .object({
    command: methodIdSchema.describe(
      'Target methodId, 5-segment grammar domain:tool:sous-domaine:command:strategie[@x.y.z] ' +
        '(e.g. "render:wardley-map:owm:parse:dsl"). See docs/architecture/ast-schema.md.',
    ),
    // Input shape is command-specific (object, string, …) — kept open on purpose.
    input: z.unknown().describe('Input passed verbatim to the target strategy. Shape depends on the command.'),
    metadata: z
      .object({
        requestId: z.string().optional(),
        requestedAt: z.string().optional(),
        callerAgent: z.string().optional(),
      })
      .optional()
      .describe('Optional caller metadata (request id, timestamp, caller agent).'),
  })
  .strict();

export type CommandCall = z.infer<typeof CommandCallSchema>;

// --- JSON-labre envelope (mirror of recipe-runner's JsonLabreEnvelope) ------
// Element shapes are intentionally permissive (e.g. `source`/`type` as strings)
// so the envelope produced by the runner validates without coupling this
// schema to the StrategyResult enums.

const SignalSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  source: z.string(),
  capturedAt: z.string(),
});

const ReasoningSchema = z.object({
  by: z.string(),
  text: z.string(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
});

const InsightSchema = z.object({
  text: z.string(),
  by: z.string(),
  type: z.string(),
  confidence: z.number().optional(),
});

const TraceEntrySchema = z.object({
  command: z.string(),
  stepId: z.string(),
  durationMs: z.number().optional(),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const JsonLabreEnvelopeSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  signals: z.array(SignalSchema),
  reasoning: z.array(ReasoningSchema),
  insights: z.array(InsightSchema),
  trace: z.array(TraceEntrySchema),
  references: z.array(z.object({ artifactPath: z.string(), jsonPath: z.string().optional() })),
});

// --- CommandResult (output envelope) ---------------------------------------

export const CommandResultSchema = z.object({
  command: methodIdSchema,
  status: z.enum(['ok', 'partial', 'error']),
  // Canonical output of the strategy (its StrategyResult, or null on error).
  output: z.unknown(),
  // Present on ok/partial; omitted on error before the strategy ran.
  envelope: JsonLabreEnvelopeSchema.optional(),
  warnings: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  metadata: z
    .object({
      durationMs: z.number().optional(),
      strategyUsed: z.string().optional(),
      versionUsed: z.string().optional(),
      recipeRunId: z.string().optional(),
      artifactPath: z.string().nullable().optional(),
    })
    .optional(),
});

export type CommandResult = z.infer<typeof CommandResultSchema>;
