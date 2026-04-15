// MCP tool definition for the estimateEvolution API
//
// Exposes a single MCP tool "estimateEvolution" that:
//   1. Classifies the component via the classification gate (social/common/economic)
//   2. If economic, evaluates evolution using the selected strategy (or all strategies)
//   3. Returns structured results conforming to the MCP tool response format
//
// The tool is designed for integration with Claude Code and other MCP-compatible clients.

import type { McpToolDefinition } from '../types/mcp.mjs';
import { classifyComponent, buildReQuestions } from '../work-on-evolution/routing/classification-gate.mjs';
import { loadStrategies, getStrategy, listStrategies } from '../work-on-evolution/strategies/capacity/registry.mjs';
import { BaseStrategy } from '../work-on-evolution/strategies/capacity/base-strategy.mjs';
import { estimateEvolutionOneShot, estimateEvolutionConversational } from '../work-on-evolution/estimate-evolution.mjs';
import { routeEstimateEvolution, detectMode, MODES } from '../work-on-evolution/routing/mode-router.mjs';
import { toErrorMessage, errorCode } from '../lib/errors.mjs';

// ─── MCP Tool Definition Schema ──────────────────────────────────────────────

/**
 * MCP tool definition for estimateEvolution.
 * Conforms to the Model Context Protocol tool schema specification.
 */
export const ESTIMATE_EVOLUTION_TOOL: McpToolDefinition = {
  name: 'estimateEvolution',
  description:
    'Estimate the Wardley Map evolution position of a component. ' +
    'Transparently handles both named solutions (e.g. "Kubernetes", "Salesforce") and abstract capabilities (e.g. "CRM", "container orchestration"). ' +
    'Solutions are evaluated against 12 Wardley evolution properties (Market, Knowledge, Perception, etc.); ' +
    'capabilities use pluggable strategies (s-curve, pub-distribution, etc.). ' +
    'Routing is automatic: naming convention detection (≥90% confidence) or LLM + web search fallback. ' +
    'Pre-filters by economic space (social good / common good / economic) via a classification gate. ' +
    'Social good and common good components trigger re-questioning instead of evaluation. ' +
    'Returns {evolution, confidence, method} for each strategy, plus routing metadata showing which pipeline was used.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name (e.g. "ERP", "LLM", "Electricity", "Air")',
      },
      context: {
        type: 'string',
        description:
          'Business or usage context for the component (e.g. "Enterprise software for sales teams", "Western power supply today")',
      },
      certitude: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'How well-understood and defined the component is (0 = novel/uncertain, 1 = fully understood). Required by s-curve strategy.',
      },
      ubiquity: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'How widespread the component is (0 = rare, 1 = ubiquitous). Required by s-curve strategy.',
      },
      wonder: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Proportion of publications describing novelty/wonder (0–1). Used by pub-distribution strategy.',
      },
      build: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Proportion of publications focused on building/learning/experimenting (0–1). Used by pub-distribution strategy.',
      },
      operate: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Proportion of publications about maintenance/operations/features (0–1). Used by pub-distribution strategy.',
      },
      usage: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Proportion of publications about commodity usage (0–1). Used by pub-distribution strategy.',
      },
      description: {
        type: 'string',
        description:
          'Free-text description of the component for strategies that use semantic analysis.',
      },
      space: {
        type: 'string',
        enum: ['economic', 'social_good', 'common_good'],
        description:
          'Pre-classification of the component\'s economic space. ' +
          'If provided, bypasses the classification gate. ' +
          'If omitted, the gate auto-detects from name + context.',
      },
      strategy: {
        type: 'string',
        description:
          'Strategy to use for evaluation. Use "all" to run all available strategies. ' +
          'If omitted, defaults to "all". Available strategies are auto-discovered from the strategies directory.',
        default: 'all',
      },
      mode: {
        type: 'string',
        enum: ['oneshot', 'guided', 'conversational', 'auto', 'default'],
        description:
          'Execution mode. "oneshot" accepts all parameters in a single call. ' +
          '"guided" (or "conversational") enables multi-turn interaction that progressively asks clarifying questions. ' +
          '"auto" (or "default") auto-detects: uses one-shot when space or evaluation params are provided, guided otherwise. ' +
          'If omitted, auto-detection is used.',
        default: 'auto',
      },
      sessionState: {
        type: 'string',
        description:
          'Serialized session state from a previous conversational exchange. ' +
          'Only used when mode is "conversational". Pass the sessionState from the previous response to continue the conversation.',
      },
      forceEstimate: {
        type: 'boolean',
        description:
          'When true, forces estimation with whatever data has been gathered so far. ' +
          'Only used in "conversational" mode when you want to skip remaining questions.',
        default: false,
      },
      pipeline: {
        type: 'boolean',
        description:
          'When true, enables enriched pipeline mode that orchestrates 3 evaluations: ' +
          '(1) capability pivot — the abstract capability is evaluated first as central anchor, ' +
          '(2) state-of-the-art solution — a modern/SotA implementation of that capability, ' +
          '(3) legacy solution — an older/legacy implementation. ' +
          'Produces a complete OWM (onlinewardleymaps.com) output with pipeline syntax ' +
          'containing component, pipeline, and label declarations. ' +
          'When omitted or false, the default single-evaluation behavior is preserved.',
        default: false,
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

// ─── Input Validation ────────────────────────────────────────────────────────

/**
 * Validate and normalize tool input.
 * Throws descriptive errors for invalid inputs.
 *
 * @param {*} input - Raw tool input
 * @returns {Object} Validated and normalized input
 */
function validateInput(input: any): any {
  if (input == null || typeof input !== 'object') {
    throw new Error('Input must be a non-null object');
  }

  const { name, context, strategy, certitude, ubiquity, wonder, build, operate, usage, description, space, mode, pipeline } = input;

  // Required: name
  if (name == null || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Required parameter "name" must be a non-empty string');
  }

  // Optional strings
  if (context != null && typeof context !== 'string') {
    throw new Error('Parameter "context" must be a string');
  }
  if (strategy != null && typeof strategy !== 'string') {
    throw new Error('Parameter "strategy" must be a string');
  }
  if (description != null && typeof description !== 'string') {
    throw new Error('Parameter "description" must be a string');
  }

  // Optional numeric fields in [0, 1]
  const numericFields = { certitude, ubiquity, wonder, build, operate, usage };
  for (const [field, value] of Object.entries(numericFields)) {
    if (value != null) {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new Error(`Parameter "${field}" must be a number, got ${typeof value}`);
      }
      if (value < 0 || value > 1) {
        throw new Error(`Parameter "${field}" must be between 0 and 1, got ${value}`);
      }
    }
  }

  return {
    name: name.trim(),
    context: (context || '').trim(),
    strategy: (strategy || 'all').trim(),
    ...(certitude != null && { certitude }),
    ...(ubiquity != null && { ubiquity }),
    ...(wonder != null && { wonder }),
    ...(build != null && { build }),
    ...(operate != null && { operate }),
    ...(usage != null && { usage }),
    ...(description != null && { description: description.trim() }),
    ...(pipeline != null && { pipeline: Boolean(pipeline) }),
  };
}

// ─── MCP Tool Handler ─────────────────────────────────────────────────────────

/**
 * Handle an estimateEvolution tool call.
 *
 * Uses the mode router for unified mode selection:
 *   - Explicit mode param → uses that mode
 *   - Auto-detect: sessionState → guided, space/eval-params → oneshot, else → guided
 *   - Both modes share the same response formatter for consistent output
 *
 * The legacy default pipeline is preserved as a fallback when mode routing
 * is not applicable (e.g., direct programmatic calls without mode context).
 *
 * @param {Object} rawInput - Tool input matching ESTIMATE_EVOLUTION_TOOL.inputSchema
 * @returns {Promise<Object>} MCP tool response with classification, evaluations, and message
 */
export async function handleEstimateEvolution(rawInput: Record<string, unknown>): Promise<unknown> {
  // Step 0: Validate and normalize input
  const validated = validateInput(rawInput);
  const { name, context, strategy, ...componentData } = validated;

  // ── Mode Router: unified mode selection and dispatch ───────────────
  //
  // The mode router handles explicit mode parameters ('oneshot', 'guided',
  // 'conversational') and auto-detection ('auto', 'default', or omitted).
  // It returns a consistently shaped response including formatted output.

  const routerInput = {
    name,
    description: context,
    context,
    strategy,
    ...componentData,
    // Pass through mode-related params from raw input
    mode: rawInput?.mode,
    space: rawInput?.space,
    sessionState: rawInput?.sessionState,
    forceEstimate: rawInput?.forceEstimate,
    compact: rawInput?.compact,
    pipeline: rawInput?.pipeline,
  };

  const routed = await routeEstimateEvolution(routerInput);

  // Return the routed response — it already contains all fields:
  // mode, modeReason, classification, reQuestions, evaluations, message,
  // formatted, sessionState, nextQuestion, phase
  return routed;
}

// ─── MCP Server Registration Helper ──────────────────────────────────────────

/**
 * Register the estimateEvolution tool with an MCP server instance.
 * Compatible with the @modelcontextprotocol/sdk Server class.
 *
 * @param {Object} server - MCP server instance with setRequestHandler or tool()
 */
export function registerMcpTool(server: any): void {
  /**
   * Format a successful result or an error into MCP content response.
   * @param {Function} handler - async function returning the result
   * @returns {Promise<Object>} MCP-formatted content response
   */
  async function mcpContentResponse(handler: () => Promise<unknown>): Promise<any> {
    try {
      const result = await handler();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: toErrorMessage(err) }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  // Pattern 1: MCP SDK server.tool() convenience method
  if (typeof server.tool === 'function') {
    server.tool(
      ESTIMATE_EVOLUTION_TOOL.name,
      ESTIMATE_EVOLUTION_TOOL.description,
      ESTIMATE_EVOLUTION_TOOL.inputSchema.properties,
      async (input: Record<string, unknown>) => mcpContentResponse(() => handleEstimateEvolution(input))
    );
    return;
  }

  // Pattern 2: MCP SDK setRequestHandler for tools/list and tools/call
  if (typeof server.setRequestHandler === 'function') {
    // Register tool listing
    server.setRequestHandler('tools/list', async () => ({
      tools: [ESTIMATE_EVOLUTION_TOOL],
    }));

    // Register tool execution
    server.setRequestHandler('tools/call', async (request: any) => {
      if (request.params.name !== ESTIMATE_EVOLUTION_TOOL.name) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${request.params.name}` }) }],
          isError: true,
        };
      }
      return mcpContentResponse(() => handleEstimateEvolution(request.params.arguments));
    });
    return;
  }

  throw new Error(
    'Unsupported MCP server interface. Expected server.tool() or server.setRequestHandler().'
  );
}

// ─── Self-test ────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('MCP Tool Definition:');
  console.log(JSON.stringify(ESTIMATE_EVOLUTION_TOOL, null, 2));
  console.log();

  // Test classification gate integration
  console.log('--- Test: Economic component (ERP) ---');
  const erpResult = await handleEstimateEvolution({
    name: 'ERP',
    context: 'Big corporate',
    certitude: 0.9,
    ubiquity: 0.85,
    strategy: 's-curve',
  });
  console.log(JSON.stringify(erpResult, null, 2));
  console.log();

  console.log('--- Test: Social good component (Air) ---');
  const airResult = await handleEstimateEvolution({
    name: 'Air',
    context: 'Atmospheric oxygen available to grow crops',
  });
  console.log(JSON.stringify(airResult, null, 2));
  console.log();

  console.log('--- Test: Common good component (Public Domain) ---');
  const pdResult = await handleEstimateEvolution({
    name: 'Public Domain',
    context: 'Shared knowledge collectively managed',
  });
  console.log(JSON.stringify(pdResult, null, 2));

  // Test input validation
  console.log('--- Test: Input validation ---');
  const validationTests = [
    { input: null, expectError: 'non-null object' },
    { input: {}, expectError: 'non-empty string' },
    { input: { name: '' }, expectError: 'non-empty string' },
    { input: { name: 'X', certitude: 2 }, expectError: 'between 0 and 1' },
    { input: { name: 'X', certitude: 'abc' }, expectError: 'must be a number' },
  ];
  for (const vt of validationTests) {
    try {
      await handleEstimateEvolution(vt.input);
      console.log(`  ✗ Expected error for ${JSON.stringify(vt.input)}`);
    } catch (err) {
      const ok = toErrorMessage(err).includes(vt.expectError);
      console.log(`  ${ok ? '✓' : '✗'} ${JSON.stringify(vt.input)} → ${toErrorMessage(err)}`);
    }
  }

  // Test strategy=all runs all strategies
  console.log('\n--- Test: All strategies on ERP ---');
  const allResult = await handleEstimateEvolution({
    name: 'ERP',
    context: 'Enterprise resource planning for large corporations',
    certitude: 0.9,
    ubiquity: 0.85,
  }) as { evaluations: Record<string, unknown> };
  console.log(`  Strategies evaluated: ${Object.keys(allResult.evaluations).join(', ')}`);
  for (const [method, evRaw] of Object.entries(allResult.evaluations)) {
    const ev = evRaw as { error?: string; evolution?: number; confidence?: number };
    if (ev.error) {
      console.log(`  ${method}: error - ${ev.error}`);
    } else {
      console.log(`  ${method}: evolution=${ev.evolution}, confidence=${ev.confidence}`);
    }
  }

  // List available strategies
  console.log('\n--- Available strategies ---');
  const strategies = await listStrategies();
  console.log(strategies);
}
