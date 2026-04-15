// MCP tool definition for the estimateEvolution API
//
// Exposes a single MCP tool "estimateEvolution" that:
//   1. Classifies the component via the classification gate (social/common/economic)
//   2. If economic, evaluates evolution using the selected strategy (or all strategies)
//   3. Returns structured results conforming to the MCP tool response format
//
// The tool is designed for integration with Claude Code and other MCP-compatible clients.

import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from '../types/mcp.mjs';
import { EstimateEvolutionInputSchema, type EstimateEvolutionInput } from '../schemas/estimate-evolution.schema.mjs';
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
  inputSchema: z.toJSONSchema(EstimateEvolutionInputSchema, { io: 'input' }) as JsonSchema,
};

// ─── Input Validation ────────────────────────────────────────────────────────

/**
 * Validate and normalize tool input.
 * Throws descriptive errors for invalid inputs.
 *
 * @param {*} input - Raw tool input
 * @returns {Object} Validated and normalized input
 */
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
  // Step 0: Validate and normalize input via Zod (throws ZodError on invalid input)
  const validated: EstimateEvolutionInput = EstimateEvolutionInputSchema.parse(rawInput);
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
