// Mode router: unified entry point for estimateEvolution requests
//
// Provides mode selection logic that:
//   1. Accepts an explicit mode parameter ('oneshot' | 'guided')
//   2. Auto-detects mode from input signals when mode is not specified
//   3. Routes to the correct handler (one-shot or conversational guided)
//   4. Returns responses through shared formatting
//
// Auto-detection heuristics:
//   → guided: sessionState present (continuing a conversation)
//   → oneshot: sufficient params for direct evaluation (name + certitude/ubiquity or pub data)
//   → guided: minimal input (only name, or name + description without numeric params)
//
// Both modes share the same response formatter for consistent output.

import { estimateEvolutionOneShot, estimateEvolutionConversational } from '../estimate-evolution.mjs';
import { formatResponse } from '../../../lib/response-formatter.mjs';
import type { RoutedResponse, EstimateEvolutionResponse, GuidedTurnResponse } from '../../../types/routing.mjs';

// ─── Mode Constants ────────────────────────────────────────────────────────

/** Supported execution modes */
export const MODES = {
  ONESHOT: 'oneshot',
  GUIDED: 'guided',
};

/** Aliases mapped to canonical mode names */
const MODE_ALIASES = {
  oneshot: MODES.ONESHOT,
  'one-shot': MODES.ONESHOT,
  'one_shot': MODES.ONESHOT,
  single: MODES.ONESHOT,
  direct: MODES.ONESHOT,
  guided: MODES.GUIDED,
  conversational: MODES.GUIDED,
  conversation: MODES.GUIDED,
  interactive: MODES.GUIDED,
  multiturn: MODES.GUIDED,
  'multi-turn': MODES.GUIDED,
  multi_turn: MODES.GUIDED,
};

// ─── Mode Detection ────────────────────────────────────────────────────────

/**
 * Determine whether the input has enough numeric parameters for a meaningful
 * one-shot evaluation (beyond just the classification gate).
 *
 * @param {Object} input - Request input
 * @returns {boolean} True if there are enough params for one-shot evaluation
 */
// any: input is the raw MCP arguments bag (validated downstream)
function hasEvaluationParams(input: any): boolean {
  if (!input || typeof input !== 'object') return false;

  // S-curve params: certitude + ubiquity
  const hasSCurveParams = input.certitude != null && input.ubiquity != null;

  // Distribution-based params: phaseDistribution with at least one bin
  const hasPhaseDistribution =
    input.phaseDistribution
    && Array.isArray(input.phaseDistribution.bins)
    && input.phaseDistribution.bins.length > 0;

  // At least one complete param set for a strategy
  return hasSCurveParams || hasPhaseDistribution;
}

/**
 * Detect the execution mode from the input signals.
 *
 * Decision tree:
 *   1. Explicit mode parameter → use it (resolved through aliases)
 *   2. sessionState present → guided (continuing a conversation)
 *   3. space explicitly provided → oneshot (user knows the classification)
 *   4. Sufficient evaluation params → oneshot (enough data for strategies)
 *   5. Otherwise → guided (need to gather more context)
 *
 * @param {Object} input - Raw request input
 * @returns {{ mode: string, reason: string }} Detected mode and reason for the choice
 */
// any: input is the raw MCP arguments bag (mode/space/sessionState/eval params auto-detected)
export function detectMode(input: any): { mode: string; reason: string } {
  if (!input || typeof input !== 'object') {
    return { mode: MODES.GUIDED, reason: 'no valid input — defaulting to guided mode' };
  }

  // 1. Explicit mode parameter
  if (input.mode != null && typeof input.mode === 'string') {
    const normalized = input.mode.trim().toLowerCase();
    const canonical = (MODE_ALIASES as Record<string, string>)[normalized];
    if (canonical) {
      return { mode: canonical, reason: `explicit mode parameter: "${input.mode}"` };
    }
    // 'default' or unrecognized → fall through to auto-detection
    if (normalized !== 'default' && normalized !== 'auto') {
      return { mode: MODES.GUIDED, reason: `unrecognized mode "${input.mode}" — defaulting to guided` };
    }
  }

  // 2. Session state present → continuing a guided conversation
  if (input.sessionState) {
    return { mode: MODES.GUIDED, reason: 'sessionState present — continuing guided conversation' };
  }

  // 3. Explicit space → user pre-classified, likely one-shot
  if (input.space != null) {
    return { mode: MODES.ONESHOT, reason: 'space pre-classified — using one-shot mode' };
  }

  // 4. Sufficient evaluation parameters → one-shot
  if (hasEvaluationParams(input)) {
    return { mode: MODES.ONESHOT, reason: 'sufficient evaluation parameters for direct estimation' };
  }

  // 5. Default: guided mode (gather more context)
  return { mode: MODES.GUIDED, reason: 'insufficient parameters — using guided mode to gather context' };
}

// ─── Shared Response Shape ─────────────────────────────────────────────────

/**
 * @typedef {Object} RoutedResponse
 * @property {string}  mode             - 'oneshot' or 'guided'
 * @property {string}  modeReason       - Why this mode was selected
 * @property {Object}  classification   - Classification gate result
 * @property {string[]|null} reQuestions - Re-questioning prompts for non-economic
 * @property {Object|null}   evaluations - Strategy evaluation results
 * @property {string}  message          - Human-readable summary
 * @property {string}  formatted        - Markdown-formatted output (shared formatter)
 * @property {string|null} sessionState - Session state for guided mode continuation
 * @property {Object|null}  nextQuestion - Next question in guided mode
 * @property {string|null}  phase        - Current phase in guided mode
 * @property {Object|null}  routing      - Solution/capability routing metadata (type, confidence, method, evalMode)
 */

// ─── Unified Router ────────────────────────────────────────────────────────

/**
 * Route an estimateEvolution request to the appropriate mode handler
 * and return a consistently shaped response.
 *
 * This is the single entry point for all estimateEvolution requests,
 * whether from MCP tool calls, skill invocations, or direct API use.
 *
 * @param {Object} input - Request input with optional mode parameter
 * @returns {Promise<RoutedResponse>} Unified response with mode, results, and formatting
 */
// any: input is raw MCP arguments bag
export async function routeEstimateEvolution(input: any = {}): Promise<EstimateEvolutionResponse> {
  const { mode, reason } = detectMode(input);

  if (mode === MODES.ONESHOT) {
    return routeOneShot(input, reason);
  }

  return routeGuided(input, reason);
}

// ─── One-Shot Route ────────────────────────────────────────────────────────

/**
 * Route to one-shot mode: all parameters in a single call.
 *
 * @param {Object} input - Request input
 * @param {string} modeReason - Why one-shot was selected
 * @returns {Promise<RoutedResponse>}
 */
async function routeOneShot(input: any, modeReason: string): Promise<RoutedResponse> {
  // Map input to one-shot API format
  const oneShotInput = {
    name: input.name,
    description: input.description,
    context: input.context,
    space: input.space,
    strategy: input.strategy || 'all',
    ...(input.certitude != null && { certitude: input.certitude }),
    ...(input.ubiquity != null && { ubiquity: input.ubiquity }),
    ...(input.phaseDistribution != null && { phaseDistribution: input.phaseDistribution }),
    ...(input.pipeline != null && { pipeline: Boolean(input.pipeline) }),
  };

  const result = await estimateEvolutionOneShot(oneShotInput);

  // Format through shared formatter
  const formatted = formatResponse(result, {
    component: oneShotInput,
    compact: input.compact || false,
  });

  // When pipeline mode is active, the result has a different shape with
  // pipeline-specific fields (owmOutput, capabilityPivot, sotaSolution, etc.).
  // Standard fields live under result.standardResult in that case.
  const r = result as any;  // any: result is a RoutedResponse | PipelineResponse union
  const std: any = r.pipeline ? (r.standardResult || {}) : r;

  const response: any = {
    mode: MODES.ONESHOT,
    modeReason,
    classification: std.classification || r.classification,
    reQuestions: std.reQuestions || r.reQuestions,
    evaluations: std.evaluations || r.evaluations,
    message: std.message || r.message,
    formatted,
    // One-shot mode has no session state or questions
    sessionState: null,
    nextQuestion: null,
    phase: null,
    // Pass through routing metadata (solution/capability detection + confidence)
    routing: std.routing || r.routing || null,
  };

  // Pass through pipeline-specific fields when pipeline mode is active
  if (r.pipeline) {
    response.pipeline = true;
    response.owmOutput = r.owmOutput;
    response.owm = r.owm;
    response.capabilityPivot = r.capabilityPivot;
    response.sotaSolution = r.sotaSolution;
    response.legacySolution = r.legacySolution;
    response.discoveredSolutions = r.discoveredSolutions;
    response.componentName = r.componentName;
  }

  return response;
}

// ─── Guided Route ──────────────────────────────────────────────────────────

/**
 * Route to guided (conversational) mode: progressive question-asking.
 *
 * @param {Object} input - Request input
 * @param {string} modeReason - Why guided was selected
 * @returns {Promise<RoutedResponse>}
 */
async function routeGuided(input: any, modeReason: string): Promise<GuidedTurnResponse> {
  // Build conversational input
  const conversationalInput: any = {
    sessionState: input.sessionState || null,
    data: {} as Record<string, any>,
    forceEstimate: input.forceEstimate || false,
    strategy: input.strategy,
  };

  // Map all available data into the conversational data payload
  if (input.name) conversationalInput.data.name = input.name;
  if (input.description) conversationalInput.data.description = input.description;
  if (input.context) conversationalInput.data.context = input.context;
  if (input.space) conversationalInput.data.space = input.space;
  if (input.certitude != null) conversationalInput.data.certitude = input.certitude;
  if (input.ubiquity != null) conversationalInput.data.ubiquity = input.ubiquity;
  if (input.phaseDistribution != null) conversationalInput.data.phaseDistribution = input.phaseDistribution;
  if (input.sector) conversationalInput.data.sector = input.sector;
  if (input.maturitySignals) conversationalInput.data.maturitySignals = input.maturitySignals;
  if (input.marketDynamics) conversationalInput.data.marketDynamics = input.marketDynamics;
  if (input.adoptionPattern) conversationalInput.data.adoptionPattern = input.adoptionPattern;

  const result = await estimateEvolutionConversational(conversationalInput);

  // Format through shared formatter for complete results;
  // for intermediate turns, format inline
  let formatted;
  if (result.phase === 'complete') {
    formatted = formatResponse(result, {
      component: conversationalInput.data,
      compact: input.compact || false,
    });
  } else {
    formatted = formatGuidedTurn(result);
  }

  return {
    mode: MODES.GUIDED as 'guided',
    modeReason,
    classification: result.classification,
    reQuestions: result.reQuestions,
    evaluations: result.evaluations,
    message: result.message,
    formatted,
    sessionState: result.sessionState,
    nextQuestion: result.nextQuestion || null,
    phase: result.phase,
    // Pass through routing metadata (solution/capability detection + confidence)
    routing: (result as any).routing || null,  // any: routing is an optional extension field
  };
}

// ─── Guided Turn Formatter ─────────────────────────────────────────────────

/**
 * Format an intermediate guided turn into markdown.
 * Uses the shared response formatter's conventions for consistent styling.
 *
 * @param {Object} result - Result from estimateEvolutionConversational
 * @returns {string} Markdown-formatted response
 */
// any: result is the conversational session output (loose shape)
function formatGuidedTurn(result: any): string {
  const lines = [];

  // Re-questioning for non-economic components
  if (result.reQuestions && result.reQuestions.length > 0) {
    const name = result.summary?.gathered?.name || 'the component';
    lines.push(`## Evolution Estimation: ${name}`);
    lines.push('');
    lines.push(`**Classification:** ${result.classification?.space}`);
    lines.push('');
    lines.push('### ⚠️ Component Outside Economic Space');
    lines.push('');
    lines.push('Evolution evaluation is not applicable. Please consider:');
    lines.push('');
    for (let i = 0; i < result.reQuestions.length; i++) {
      lines.push(`${i + 1}. ${result.reQuestions[i]}`);
    }
    lines.push('');
    lines.push('💡 *Re-specify with economic context to proceed (e.g., "bottled oxygen" instead of "air").*');
    return lines.join('\n');
  }

  // Intermediate turn: present next question with progress
  const nextQ = result.nextQuestion;
  if (!nextQ) {
    return 'Session state is unclear. Provide more data or use `forceEstimate: true` to proceed.';
  }

  // Phase order depends on whether the component is on the solution or capability path
  const isSolutionPath = result.summary?.componentType === 'solution' ||
    result.summary?.gathered?.componentType === 'solution';

  const phaseOrder = isSolutionPath
    ? ['identity', 'classification', 'solution_context', 'ready']
    : ['identity', 'classification', 'characteristics', 'market_signals', 'ready'];

  const currentIdx = phaseOrder.indexOf(result.phase);
  const totalPhases = phaseOrder.length - 1;
  const phaseLabels = {
    identity: 'Component Identity',
    classification: 'Economic Classification',
    characteristics: 'Maturity Characteristics',
    market_signals: 'Market & Publication Signals',
    solution_context: 'Solution Context (12-Property Evaluation)',
  } as Record<string, string>;

  lines.push(`### Guided Estimation — Phase ${currentIdx + 1}/${totalPhases}: ${phaseLabels[result.phase] || result.phase}`);
  lines.push('');

  // Progress bar
  const progressPct = Math.round((currentIdx / totalPhases) * 100);
  const filled = Math.round(progressPct / 10);
  lines.push(`Progress: [${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${progressPct}%`);
  lines.push('');

  // Main question
  lines.push(`**${nextQ.prompt}**`);
  lines.push('');

  // Hints
  if (nextQ.hints && nextQ.hints.length > 0) {
    for (const hint of nextQ.hints) {
      if (hint.startsWith('✓') || hint === '') {
        lines.push(`  ${hint}`);
      } else {
        lines.push(`  - ${hint}`);
      }
    }
    lines.push('');
  }

  // Gathered context
  const summary = result.summary;
  if (summary && Object.keys(summary.gathered).length > 0) {
    lines.push('**Already gathered:**');
    for (const [key, val] of Object.entries(summary.gathered)) {
      if (key !== 'space' && key !== 'strategy') {
        const display = typeof val === 'number' ? val.toFixed(2) : val;
        lines.push(`  - ${key}: ${display}`);
      }
    }
    lines.push('');
  }

  lines.push('*Tip: Provide all values at once for one-shot mode, or say "estimate now" to force estimation with available data.*');

  return lines.join('\n');
}
