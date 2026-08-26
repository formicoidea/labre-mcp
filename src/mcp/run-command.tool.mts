// MCP tool definition for `runCommand` — direct invocation of any strategy by
// its 5-segment methodId (ast-schema.md § 3.4.1 CommandCall / CommandResult).
//
// A single command is run through the kernel as a degenerate 1-step recipe
// (see `runCommand` in core/recipe), so the result carries the same JSON-labre
// envelope (signals / reasoning / insights / trace) and persists an artefact
// under ~/.labre-mcp/runs/ — just like a recipe run. This makes single-step
// recipes unnecessary: call the command directly instead.

import { z } from 'zod';
import type { ToolDefinition } from '#core/registry/tool-registry.mjs';
import { CommandCallSchema, type CommandResult } from '#schemas/command.schema.mjs';
import { runCommand } from '#core/recipe/recipe-runner.mjs';
import { buildStrategyRegistry } from '#frameworks/registry-boot.mjs';
import { attachArtifactWriter } from '#core/listeners/artifact-writer-listener.mjs';
import { attachRunTelemetryIfConfigured } from '#core/listeners/posthog-telemetry-listener.mjs';
import { createEventBus } from '#core/bus/event-bus.mjs';
import { resolveContext } from './resolve-context.mjs';
import { coerceJsonInput } from './coerce-json-input.mjs';
import { LABRE_METERING_HOOKS } from './metering-hooks.mjs';

export const RUN_COMMAND_TOOL: ToolDefinition = {
  name: 'runCommand',
  description:
    'Invoke a single strategy directly by its 5-segment methodId and get a CommandResult ' +
    '(canonical output + JSON-labre envelope: signals, reasoning, insights, trace). ' +
    'Input: { command: "<domain:tool:sous-domaine:command:strategie>", input: <command-specific> }. ' +
    'Use this instead of a single-step recipe. The full methodId catalogue (real vs mock) is in ' +
    'docs/architecture/ast-schema.md. An unknown methodId returns status "error".',
  // any: zod-to-json conversion — the schema is well-typed at the Zod layer
  inputSchema: z.toJSONSchema(CommandCallSchema, { io: 'input' }) as Record<string, unknown>,
  // Telemetry target (CH-09): the methodId actually addressed. Validated
  // through the tool's OWN schema field before it can become a PostHog
  // property — the 5-segment grammar is what bounds its cardinality; an
  // arbitrary caller string yields no target at all.
  telemetryTarget(args) {
    const parsed = CommandCallSchema.shape.command.safeParse(
      (args as { command?: unknown } | null)?.command,
    );
    return parsed.success ? parsed.data : undefined;
  },
  // Returns a bare CommandResult; the daemon dispatch wraps every handler in
  // withMcpDegradation (Degradable<T>) — do NOT self-wrap here (hard rule #18).
  async handler(args, context): Promise<CommandResult> {
    const call = CommandCallSchema.parse(args);
    const ctx = await resolveContext(context);
    const registry = buildStrategyRegistry();
    const bus = createEventBus();

    // Caller-owned AST so the artefact-writer listener sees the live object
    // (mutated in place by the runner, read at run-end).
    const ast: Record<string, unknown> = {};
    const artifactHandle = attachArtifactWriter({ bus, context: ctx, getAst: () => ast });
    // Run-level telemetry (mcp_run_end / mcp_step_error), metadata only. A
    // command runs through the same kernel as a recipe, so it emits the same
    // events — CH-09 removed the accident that only runRecipe forwarded them.
    attachRunTelemetryIfConfigured({ bus, context: ctx });

    try {
      const outcome = await runCommand({
        command: call.command,
        input: coerceJsonInput(call.input),
        context: ctx,
        registry,
        bus,
        ast,
        // Metering: labre's quota gate + cost ledger, installed HERE (the
        // delivery seam) rather than inside the runner — CH-23 / ARCH-27.
        hooks: LABRE_METERING_HOOKS,
      });
      const artifactPath = await artifactHandle.artifactPath;
      return {
        command: call.command,
        status: 'ok',
        output: outcome.ast.result ?? null,
        envelope: outcome.envelope,
        metadata: {
          recipeRunId: outcome.recipeRunId,
          artifactPath,
          strategyUsed: call.command,
        },
      };
    } catch (err) {
      await artifactHandle.detach();
      return {
        command: call.command,
        status: 'error',
        output: null,
        errors: [(err as Error)?.message ?? String(err)],
        metadata: { strategyUsed: call.command },
      };
    }
  },
};
