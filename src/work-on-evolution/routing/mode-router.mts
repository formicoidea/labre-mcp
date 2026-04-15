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
import { formatResponse } from '../../lib/response-formatter.mjs';
import type { RoutedResponse } from '../../types/routing.mjs';

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

  // Publication distribution: wonder + build + operate + usage
  const hasPubParams =
    input.wonder != null && input.build != null &&
    input.operate != null && input.usage != null;

  // At least one complete param set for a strategy
  return hasSCurveParams || hasPubParams;
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
// any: input is MCP raw arguments; output is RoutedResponse | guided-turn shape
export async function routeEstimateEvolution(input: any = {}): Promise<any> {
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
    description: input.description || input.context || '',
    space: input.space,
    strategy: input.strategy || 'all',
    ...(input.certitude != null && { certitude: input.certitude }),
    ...(input.ubiquity != null && { ubiquity: input.ubiquity }),
    ...(input.wonder != null && { wonder: input.wonder }),
    ...(input.build != null && { build: input.build }),
    ...(input.operate != null && { operate: input.operate }),
    ...(input.usage != null && { usage: input.usage }),
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
async function routeGuided(input: any, modeReason: string): Promise<any> {  // any: guided-turn shape
  // Build conversational input
  const conversationalInput: any = {
    sessionState: input.sessionState || null,
    data: {} as Record<string, any>,
    forceEstimate: input.forceEstimate || false,
    strategy: input.strategy,
  };

  // Map all available data into the conversational data payload
  if (input.name) conversationalInput.data.name = input.name;
  if (input.description || input.context) {
    conversationalInput.data.description = input.description || input.context;
  }
  if (input.space) conversationalInput.data.space = input.space;
  if (input.certitude != null) conversationalInput.data.certitude = input.certitude;
  if (input.ubiquity != null) conversationalInput.data.ubiquity = input.ubiquity;
  if (input.wonder != null) conversationalInput.data.wonder = input.wonder;
  if (input.build != null) conversationalInput.data.build = input.build;
  if (input.operate != null) conversationalInput.data.operate = input.operate;
  if (input.usage != null) conversationalInput.data.usage = input.usage;
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
    mode: MODES.GUIDED,
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

// ─── Self-test ─────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== mode-router self-test ===\n');

  // Test 1: Mode detection — explicit oneshot
  console.log('--- Test 1: Explicit oneshot mode ---');
  const d1 = detectMode({ name: 'ERP', mode: 'oneshot' });
  console.log(`  Mode: ${d1.mode}, Reason: ${d1.reason}`);
  console.assert(d1.mode === 'oneshot', 'Should be oneshot');

  // Test 2: Mode detection — explicit guided
  console.log('--- Test 2: Explicit guided mode ---');
  const d2 = detectMode({ name: 'ERP', mode: 'guided' });
  console.log(`  Mode: ${d2.mode}, Reason: ${d2.reason}`);
  console.assert(d2.mode === 'guided', 'Should be guided');

  // Test 3: Mode detection — conversational alias
  console.log('--- Test 3: Conversational alias ---');
  const d3 = detectMode({ name: 'ERP', mode: 'conversational' });
  console.log(`  Mode: ${d3.mode}, Reason: ${d3.reason}`);
  console.assert(d3.mode === 'guided', 'Should be guided');

  // Test 4: Auto-detect — sessionState present
  console.log('--- Test 4: Auto-detect with sessionState ---');
  const d4 = detectMode({ name: 'ERP', sessionState: '{"phase":"characteristics"}' });
  console.log(`  Mode: ${d4.mode}, Reason: ${d4.reason}`);
  console.assert(d4.mode === 'guided', 'Should be guided (sessionState)');

  // Test 5: Auto-detect — space provided
  console.log('--- Test 5: Auto-detect with space ---');
  const d5 = detectMode({ name: 'ERP', space: 'economic' });
  console.log(`  Mode: ${d5.mode}, Reason: ${d5.reason}`);
  console.assert(d5.mode === 'oneshot', 'Should be oneshot (space)');

  // Test 6: Auto-detect — sufficient params (s-curve)
  console.log('--- Test 6: Auto-detect with certitude+ubiquity ---');
  const d6 = detectMode({ name: 'ERP', certitude: 0.9, ubiquity: 0.85 });
  console.log(`  Mode: ${d6.mode}, Reason: ${d6.reason}`);
  console.assert(d6.mode === 'oneshot', 'Should be oneshot (eval params)');

  // Test 7: Auto-detect — sufficient params (publication)
  console.log('--- Test 7: Auto-detect with pub params ---');
  const d7 = detectMode({ name: 'ERP', wonder: 0.02, build: 0.08, operate: 0.25, usage: 0.65 });
  console.log(`  Mode: ${d7.mode}, Reason: ${d7.reason}`);
  console.assert(d7.mode === 'oneshot', 'Should be oneshot (pub params)');

  // Test 8: Auto-detect — minimal input
  console.log('--- Test 8: Auto-detect with minimal input ---');
  const d8 = detectMode({ name: 'ERP' });
  console.log(`  Mode: ${d8.mode}, Reason: ${d8.reason}`);
  console.assert(d8.mode === 'guided', 'Should be guided (minimal)');

  // Test 9: Auto-detect — mode: 'default' triggers auto
  console.log('--- Test 9: mode=default with params ---');
  const d9 = detectMode({ name: 'ERP', mode: 'default', certitude: 0.9, ubiquity: 0.85 });
  console.log(`  Mode: ${d9.mode}, Reason: ${d9.reason}`);
  console.assert(d9.mode === 'oneshot', 'Should auto-detect oneshot');

  // Test 10: Mode aliases
  console.log('--- Test 10: Mode aliases ---');
  for (const alias of ['one-shot', 'single', 'direct', 'interactive', 'multi-turn', 'multiturn']) {
    const d = detectMode({ name: 'X', mode: alias });
    console.log(`  "${alias}" → ${d.mode}`);
  }

  // Test 11: Full one-shot route
  console.log('\n--- Test 11: Full one-shot route ---');
  const r1 = await routeEstimateEvolution({
    name: 'ERP',
    description: 'Enterprise resource planning for corporations',
    space: 'economic',
    strategy: 's-curve',
    certitude: 0.9,
    ubiquity: 0.85,
  });
  console.log(`  Mode: ${r1.mode}`);
  console.log(`  Reason: ${r1.modeReason}`);
  console.log(`  Evolution: ${r1.evaluations?.['s-curve']?.evolution}`);
  console.log(`  Has formatted: ${r1.formatted?.length > 0}`);
  console.log(`  SessionState: ${r1.sessionState}`);
  console.assert(r1.mode === 'oneshot', 'Should be oneshot');
  console.assert(r1.sessionState === null, 'One-shot has no session');

  // Test 12: Full guided route (first turn)
  console.log('\n--- Test 12: Full guided route (first turn) ---');
  const r2 = await routeEstimateEvolution({
    name: 'LLM',
    description: 'Large language model for text generation',
  });
  console.log(`  Mode: ${r2.mode}`);
  console.log(`  Reason: ${r2.modeReason}`);
  console.log(`  Phase: ${r2.phase}`);
  console.log(`  Has nextQuestion: ${r2.nextQuestion != null}`);
  console.log(`  Has sessionState: ${r2.sessionState != null}`);
  console.assert(r2.mode === 'guided', 'Should be guided');
  console.assert(r2.sessionState != null, 'Guided should have session');

  // Test 13: Continue guided conversation
  console.log('\n--- Test 13: Continue guided conversation ---');
  const r3 = await routeEstimateEvolution({
    sessionState: r2.sessionState,
    certitude: 0.6,
    ubiquity: 0.5,
  });
  console.log(`  Mode: ${r3.mode}`);
  console.log(`  Phase: ${r3.phase}`);
  console.assert(r3.mode === 'guided', 'Should still be guided');

  // Test 14: Social good via one-shot
  console.log('\n--- Test 14: Social good one-shot ---');
  const r4 = await routeEstimateEvolution({
    name: 'Air',
    description: 'Atmospheric oxygen',
    mode: 'oneshot',
  });
  console.log(`  Mode: ${r4.mode}`);
  console.log(`  Space: ${r4.classification?.space}`);
  console.log(`  Has reQuestions: ${r4.reQuestions?.length > 0}`);
  console.log(`  Evaluations: ${r4.evaluations}`);
  console.assert(r4.reQuestions?.length > 0, 'Should have re-questions');

  // Test 15: Shared formatting consistency
  console.log('\n--- Test 15: Formatted output ---');
  console.log(r1.formatted.substring(0, 200) + '...');

  console.log('\n=== mode-router self-test completed ===');
}
