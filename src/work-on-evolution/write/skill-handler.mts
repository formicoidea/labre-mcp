// Skill handler: parses conversational input and invokes the evaluation API pipeline
//
// This module bridges natural-language user input (from Claude Code skill triggers)
// to the structured estimateEvolutionOneShot() API.
//
// It extracts:
//   - component name (required)
//   - description / context (optional)
//   - economic space pre-classification (optional)
//   - strategy selection (optional)
//   - numeric parameters: certitude, ubiquity, wonder, build, operate, usage (optional)
//
// Parsing is intentionally lenient — designed for conversational, not programmatic, use.

import { estimateEvolutionOneShot, estimateEvolutionConversational, listStrategies } from './estimate-evolution.mjs';
import { formatResponse, evolutionToStage, formatConfidence, strategyReasoning } from '../../lib/response-formatter.mjs';
import { routeEstimateEvolution, detectMode, MODES } from './routing/mode-router.mjs';
import { toErrorMessage, errorCode } from '../../lib/errors.mjs';

// ─── Conversational Input Parsing ──────────────────────────────────────────

/**
 * Known space aliases mapped to canonical space names.
 */
const SPACE_ALIASES = {
  // Canonical
  economic: 'economic',
  social_good: 'social_good',
  common_good: 'common_good',
  // Natural language variants
  'social good': 'social_good',
  'common good': 'common_good',
  'social-good': 'social_good',
  'common-good': 'common_good',
  socialgood: 'social_good',
  commongood: 'common_good',
  social: 'social_good',
  common: 'common_good',
  market: 'economic',
  competitive: 'economic',
};

/**
 * Known strategy aliases mapped to canonical strategy names.
 */
const STRATEGY_ALIASES = {
  all: 'all',
  's-curve': 'write:capacity:s-curve',
  scurve: 'write:capacity:s-curve',
  'publication-analysis': 'write:capacity:publication-analysis',
  'pub-analysis': 'write:capacity:publication-analysis',
  publication: 'write:capacity:publication-analysis',
  'timeline-benchmark': 'write:capacity:timeline-benchmark',
  timeline: 'write:capacity:timeline-benchmark',
  benchmark: 'write:capacity:timeline-benchmark',
  'llm-direct': 'write:capacity:llm-direct',
  llm: 'write:capacity:llm-direct',
  direct: 'write:capacity:llm-direct',
  'logprob-distribution': 'write:capacity:logprob-distribution',
  logprob: 'write:capacity:logprob-distribution',
};

/**
 * Parse a conversational input string into structured parameters.
 *
 * Supports multiple input formats:
 *   1. Structured key-value: "Component: ERP, Context: enterprise software, Space: economic"
 *   2. Bullet/dash list: "- Component: ERP\n- Description: enterprise software"
 *   3. Natural language: "Estimate evolution for ERP in the enterprise software space"
 *   4. Minimal: "ERP" (just a component name)
 *
 * @param {string} input - Raw conversational text
 * @returns {Object} Parsed parameters ready for estimateEvolutionOneShot()
 */
// any: input is freeform user text or { text } wrapper; result has dynamic field set
export function parseConversationalInput(input: any): any {
  if (input == null || typeof input !== 'string') {
    throw new Error('Conversational input must be a non-empty string');
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Conversational input must be a non-empty string');
  }

  // Try structured parsing first (key: value patterns)
  const structured = tryStructuredParse(trimmed);
  if (structured) return structured;

  // Fall back to natural language extraction
  return parseNaturalLanguage(trimmed);
}

/**
 * Try to parse structured key-value input.
 * Returns null if the input doesn't match structured patterns.
 *
 * @param {string} text
 * @returns {Object|null}
 */
// any: structured-parser output has a dynamic key/value set
function tryStructuredParse(text: string): any {
  const result: any = {};

  // Normalize comma-separated key-value pairs into newline-separated format
  // so that "Component: Docker, Strategy: all, Context: foo" works alongside
  // newline-separated and bullet-list formats.
  const KNOWN_KEYS = 'component|name|context|description|space|strategy|certitude|ubiquity|wonder|build|operate|usage';
  const commaKeyBoundary = new RegExp(`,\\s*(?=(?:${KNOWN_KEYS})\\s*[:=])`, 'gi');
  const normalized = text.replace(commaKeyBoundary, '\n');

  // Pattern: "Key: Value" (on same line or across lines)
  // Supports: Component, Name, Context, Description, Space, Strategy,
  //           Certitude, Ubiquity, Wonder, Build, Operate, Usage
  const keyValuePattern = new RegExp(
    `(?:^|\\n)\\s*[-*•]?\\s*(${KNOWN_KEYS})\\s*[:=]\\s*(.+?)` +
    `(?=\\n\\s*[-*•]?\\s*(?:${KNOWN_KEYS})\\s*[:=]|$)`,
    'gis'
  );

  let match;
  let foundAny = false;
  while ((match = keyValuePattern.exec(normalized)) !== null) {
    foundAny = true;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim().replace(/^["']|["']$/g, ''); // strip quotes

    switch (key) {
      case 'component':
      case 'name':
        result.name = value;
        break;
      case 'context':
      case 'description':
        result.description = value;
        break;
      case 'space': {
        const normalized = value.toLowerCase().trim();
        const canonical = (SPACE_ALIASES as Record<string, string>)[normalized];
        if (canonical) result.space = canonical;
        break;
      }
      case 'strategy': {
        const normalized = value.toLowerCase().trim();
        const canonical = (STRATEGY_ALIASES as Record<string, string>)[normalized];
        if (canonical) result.strategy = canonical;
        break;
      }
      case 'certitude':
      case 'ubiquity':
      case 'wonder':
      case 'build':
      case 'operate':
      case 'usage': {
        const num = parseFloat(value);
        if (!Number.isNaN(num) && num >= 0 && num <= 1) {
          result[key] = num;
        }
        break;
      }
    }
  }

  if (!foundAny) return null;

  // Must have at least a component name
  if (!result.name) return null;

  return result;
}

/**
 * Parse natural language input to extract component name and optional context.
 *
 * Handles patterns like:
 *   - "ERP" → name: ERP
 *   - "Estimate evolution for ERP" → name: ERP
 *   - "What's the evolution of LLM in coding assistance?" → name: LLM, description: coding assistance
 *   - "ERP - enterprise resource planning for corporations" → name: ERP, desc: ...
 *
 * @param {string} text
 * @returns {Object}
 */
// any: NL parser output has a dynamic key/value set
function parseNaturalLanguage(text: string): any {
  const result: any = {};

  // Strip common preamble phrases
  let cleaned = text
    .replace(/^(?:estimate|evaluate|assess|calculate|compute|determine|find|get|what(?:'s| is| are))\s+(?:the\s+)?(?:evolution|maturity|position|stage|phase)\s+(?:of|for)\s+/i, '')
    .replace(/^(?:how evolved is|where is|where does)\s+/i, '')
    .replace(/\s*\?\s*$/g, '') // trailing question mark
    .trim();

  // Check for "quoted component name" pattern
  const quotedMatch = cleaned.match(/^["']([^"']+)["']\s*(.*)/);
  if (quotedMatch) {
    result.name = quotedMatch[1].trim();
    if (quotedMatch[2]) {
      result.description = cleanDescription(quotedMatch[2]);
    }
    return enrichWithDetectedParams(result, text);
  }

  // Check for "ComponentName - description" pattern
  const dashSeparated = cleaned.match(/^(\S+(?:\s+\S+)?)\s*[-–—]\s+(.+)/);
  if (dashSeparated) {
    result.name = dashSeparated[1].trim();
    result.description = cleanDescription(dashSeparated[2]);
    return enrichWithDetectedParams(result, text);
  }

  // Check for "ComponentName in/for context" pattern
  const inForMatch = cleaned.match(/^(.+?)\s+(?:in|for|used in|used for|within)\s+(.+)/i);
  if (inForMatch) {
    result.name = inForMatch[1].trim();
    result.description = cleanDescription(inForMatch[2]);
    return enrichWithDetectedParams(result, text);
  }

  // Fallback: treat entire cleaned text as component name if short,
  // or first segment as name and rest as description
  const words = cleaned.split(/\s+/);
  if (words.length <= 3) {
    result.name = cleaned;
  } else {
    // Use first word(s) as name, rest as description
    // Heuristic: component names are typically 1-3 words, often capitalized
    const capitalizedRun = [];
    for (const word of words) {
      if (/^[A-Z]/.test(word) || /^[A-Z]+$/.test(word)) {
        capitalizedRun.push(word);
      } else {
        break;
      }
    }

    if (capitalizedRun.length > 0 && capitalizedRun.length <= 3) {
      result.name = capitalizedRun.join(' ');
      result.description = cleanDescription(
        words.slice(capitalizedRun.length).join(' ')
      );
    } else {
      // Just take first word as name
      result.name = words[0];
      result.description = cleanDescription(words.slice(1).join(' '));
    }
  }

  return enrichWithDetectedParams(result, text);
}

/**
 * Clean a description string: strip leading connectors, trim whitespace.
 * @param {string} desc
 * @returns {string}
 */
function cleanDescription(desc: string): string {
  return desc
    .replace(/^(?:that is|which is|is|as|being)\s+/i, '')
    .replace(/^[,;:]\s*/, '')
    .trim();
}

/**
 * Enrich parsed params by detecting space/strategy mentions in original text.
 * @param {Object} result - Partially parsed result
 * @param {string} originalText - Full original input
 * @returns {Object}
 */
// any: result is a partially-parsed object enriched in place with detected fields
function enrichWithDetectedParams(result: any, originalText: string): any {
  const lower = originalText.toLowerCase();

  // Detect space if not already set
  if (!result.space) {
    if (/\b(?:social[_\s-]?good|social\s+space)\b/.test(lower)) {
      result.space = 'social_good';
    } else if (/\b(?:common[_\s-]?good|common\s+space)\b/.test(lower)) {
      result.space = 'common_good';
    } else if (/\b(?:economic|market|competitive)\s+(?:space|component)\b/.test(lower)) {
      result.space = 'economic';
    }
  }

  // Detect strategy if not already set
  if (!result.strategy) {
    for (const [alias, canonical] of Object.entries(STRATEGY_ALIASES)) {
      if (alias.length > 3 && lower.includes(alias)) {
        result.strategy = canonical;
        break;
      }
    }
  }

  // Detect inline numeric values: "certitude 0.9", "ubiquity: 0.85"
  const numericFields = ['certitude', 'ubiquity', 'wonder', 'build', 'operate', 'usage'];
  for (const field of numericFields) {
    if (result[field] != null) continue;
    const numMatch = lower.match(new RegExp(`${field}\\s*[:=]?\\s*(\\d+\\.?\\d*)`, 'i'));
    if (numMatch) {
      const val = parseFloat(numMatch[1]);
      if (!Number.isNaN(val) && val >= 0 && val <= 1) {
        result[field] = val;
      }
    }
  }

  return result;
}

// ─── Skill Handler Entry Point ─────────────────────────────────────────────

/**
 * Handle a conversational skill invocation.
 *
 * This is the main entry point called by the Claude Code skill system.
 * It parses the conversational input, invokes estimateEvolutionOneShot(),
 * and returns a formatted result suitable for display in conversation.
 *
 * @param {string} conversationalInput - Raw user text that triggered the skill
 * @returns {Promise<Object>} Result from estimateEvolutionOneShot with conversational metadata
 */
// any: handler input is the raw conversational bag; result is RoutedResponse
export async function handleSkillInvocation(conversationalInput: any): Promise<any> {
  // Step 1: Parse the conversational input into structured params
  const parsed = parseConversationalInput(conversationalInput);

  // Step 2: Invoke the evaluation API pipeline
  const result = await estimateEvolutionOneShot(parsed);

  // Step 3: Add conversational metadata
  return {
    ...result,
    parsedInput: parsed,
    availableStrategies: await listStrategies(),
  };
}

/**
 * Format an evaluation result for human-readable conversational output.
 *
 * Delegates to the response-formatter module for rich output including:
 * - Evolution stage names (Genesis / Custom-Built / Product / Commodity)
 * - Confidence bars and descriptive labels
 * - Per-strategy reasoning explanations
 * - Consensus overview for multi-strategy evaluations
 * - Re-questioning guidance for non-economic components
 *
 * @param {Object} result - Result from handleSkillInvocation()
 * @param {Object} [options] - Formatting options
 * @param {boolean} [options.compact] - Use compact table format instead of detailed
 * @returns {string} Markdown-formatted conversational output
 */
// any: result/options accept heterogeneous fields driven by the RoutedResponse output
export function formatConversationalResult(result: any, options: any = {}): any {
  return formatResponse(result, {
    component: result.parsedInput,
    compact: options.compact || false,
  });
}

// Re-export formatter utilities for direct use by consumers
export { evolutionToStage, formatConfidence, strategyReasoning };

// Re-export mode router for consumers that want unified mode selection
export { routeEstimateEvolution, detectMode, MODES };

// ─── Unified Skill Entry Point with Mode Routing ─────────────────────────

/**
 * Handle a skill invocation with automatic mode selection.
 *
 * This is the recommended entry point for Claude Code skill triggers.
 * It parses conversational input, detects the optimal mode (one-shot or guided),
 * and routes through the unified mode router for consistent response formatting.
 *
 * Mode selection:
 *   - Explicit mode in input (e.g., "mode: guided") → uses that mode
 *   - sessionState present → guided (continuing conversation)
 *   - Sufficient numeric params → one-shot (direct evaluation)
 *   - Minimal input → guided (progressive gathering)
 *
 * @param {string|Object} input - Conversational text or structured input object
 * @param {Object} [options] - Additional options
 * @param {string} [options.mode] - Override mode ('oneshot' | 'guided' | 'auto')
 * @param {string} [options.sessionState] - Session state for guided continuation
 * @param {boolean} [options.forceEstimate] - Force estimation with partial data
 * @returns {Promise<Object>} Routed result with formatted output, mode info, and strategies
 */
// any: input is raw bag; options carry mode-routing tunables
export async function handleSkillWithModeRouting(input: any, options: any = {}): Promise<any> {
  // Parse conversational text into structured params
  let parsed;
  if (typeof input === 'string') {
    parsed = parseConversationalInput(input);
  } else if (input && typeof input === 'object') {
    parsed = input;
  } else {
    throw new Error('Input must be a non-empty string or object');
  }

  // Merge options into the router input. `description` and `context` carry
  // distinct semantics — pass each through without collapsing.
  const routerInput = {
    ...parsed,
    ...(parsed.description != null && { description: parsed.description }),
    ...(parsed.context != null && { context: parsed.context }),
    ...(options.mode && { mode: options.mode }),
    ...(options.sessionState && { sessionState: options.sessionState }),
    ...(options.forceEstimate != null && { forceEstimate: options.forceEstimate }),
  };

  // Route through unified mode router
  const result = await routeEstimateEvolution(routerInput);

  // Enrich with skill metadata
  return {
    ...result,
    parsedInput: parsed,
    availableStrategies: await listStrategies(),
  };
}

// ─── Conversational Guided Interaction ────────────────────────────────────

/**
 * Handle a multi-turn conversational skill invocation.
 *
 * This manages the progressive question-asking flow:
 *   Turn 1: User provides initial input -> session created, first question returned
 *   Turn N: User answers question -> data merged, next question or final result returned
 *
 * Each call returns a structured response with:
 *   - The current phase and next question to ask (if not ready)
 *   - A formatted markdown response for the user
 *   - The serialized session state to pass back on the next turn
 *   - The final evaluation results when enough context is gathered
 *
 * @param {Object} input
 * @param {string}  [input.userMessage]   - Raw user text from the current turn
 * @param {string}  [input.sessionState]  - Serialized session from previous turn (null for first turn)
 * @param {boolean} [input.forceEstimate] - Force estimation with partial data
 * @param {string}  [input.strategy]      - Strategy override (default: 'all')
 * @returns {Promise<Object>} Conversational response with phase, question, sessionState, and formatted output
 */
// any: conversational entrypoint — same loose input shape
export async function handleConversationalInvocation(input: any = {}): Promise<any> {
  const { userMessage, sessionState, forceEstimate = false, strategy } = input;

  // Parse user message into structured data if provided
  let parsedData = {};
  if (userMessage && typeof userMessage === 'string' && userMessage.trim().length > 0) {
    try {
      parsedData = parseConversationalInput(userMessage);
    } catch {
      // If parsing fails entirely, treat as free-text description/maturity signals
      parsedData = { maturitySignals: userMessage.trim() };
    }
  }

  // Delegate to the conversational engine
  const result = await estimateEvolutionConversational({
    sessionState: sessionState || null,
    data: parsedData,
    forceEstimate,
    strategy,
  });

  // Format the response for the user
  const formatted = formatConversationalTurn(result);

  return {
    ...result,
    parsedData,
    formatted,
    availableStrategies: await listStrategies(),
  };
}

/**
 * Format a conversational turn into a human-readable markdown response.
 *
 * Handles three cases:
 *   1. Intermediate turn: presents the next question with hints and progress
 *   2. Non-economic result: presents re-questioning prompts
 *   3. Final estimation: presents the strategy results and consensus
 *
 * @param {Object} result - Result from estimateEvolutionConversational()
 * @returns {string} Markdown-formatted response for this turn
 */
// any: result is the conversational session output (loose shape, formatter-only)
export function formatConversationalTurn(result: any): string {
  const lines = [];

  // ── Case 1: Non-economic component (re-questioning) ─────────────────
  if (result.reQuestions && result.reQuestions.length > 0) {
    const name = result.summary?.gathered?.name || 'the component';
    lines.push(`## Classification: ${name}`);
    lines.push('');
    lines.push(`**Space:** ${result.classification?.space}`);
    lines.push(`**Reason:** ${result.classification?.reason}`);
    lines.push('');
    lines.push('### Re-Questioning Required');
    lines.push('');
    lines.push('This component appears to fall outside the standard economic evolution axis.');
    lines.push('Please consider the following questions before proceeding:');
    lines.push('');
    for (const q of result.reQuestions) {
      lines.push(`- ${q}`);
    }
    lines.push('');
    lines.push('If you meant a commodified or market version, please re-specify the component with its economic context.');
    return lines.join('\n');
  }

  // ── Case 2: Final estimation (all questions answered) ───────────────
  if (result.phase === 'complete' && result.evaluations) {
    const name = result.summary?.gathered?.name || 'Unknown';
    lines.push(`## Evolution Estimation: ${name}`);
    lines.push('');

    // Progress summary
    const summary = result.summary;
    if (summary) {
      lines.push(`*Completed after ${summary.exchangeCount} exchange(s) — ${Object.keys(summary.gathered).length} data points gathered.*`);
      lines.push('');
    }

    // Classification
    if (result.classification) {
      lines.push(`**Space:** ${result.classification.space}`);
      lines.push('');
    }

    // Strategy results table
    lines.push('### Strategy Results');
    lines.push('');
    lines.push('| Strategy | Evolution | Confidence | Method |');
    lines.push('|----------|-----------|------------|--------|');

    for (const [method, ev] of Object.entries(result.evaluations) as [string, any][]) {
      if (ev.error) {
        lines.push(`| ${method} | — | — | Error: ${ev.error} |`);
      } else {
        lines.push(
          `| ${method} | ${ev.evolution.toFixed(3)} | ${ev.confidence.toFixed(2)} | ${ev.method} |`
        );
      }
    }
    lines.push('');

    // Consensus range
    const successful = (Object.entries(result.evaluations) as [string, any][])
      .filter(([, ev]) => !ev.error)
      .map(([, ev]) => ev.evolution);

    if (successful.length > 1) {
      const avg = successful.reduce((a, b) => a + b, 0) / successful.length;
      const min = Math.min(...successful);
      const max = Math.max(...successful);
      lines.push(`**Consensus range:** ${min.toFixed(3)} – ${max.toFixed(3)} (avg: ${avg.toFixed(3)})`);
      lines.push('');

      // Wardley phase mapping
      const phaseLabel = avg < 0.17 ? 'Genesis' : avg < 0.40 ? 'Custom-Built' : avg < 0.70 ? 'Product (+Rental)' : 'Commodity (+Utility)';
      lines.push(`**Wardley Phase:** ${phaseLabel}`);
      lines.push('');
    } else if (successful.length === 1) {
      const val = successful[0];
      const phaseLabel = val < 0.17 ? 'Genesis' : val < 0.40 ? 'Custom-Built' : val < 0.70 ? 'Product (+Rental)' : 'Commodity (+Utility)';
      lines.push(`**Wardley Phase:** ${phaseLabel}`);
      lines.push('');
    }

    // Gathered context
    if (summary && Object.keys(summary.gathered).length > 0) {
      lines.push('<details>');
      lines.push('<summary>Context gathered during conversation</summary>');
      lines.push('');
      for (const [key, val] of Object.entries(summary.gathered)) {
        if (key !== 'space') {
          lines.push(`- **${key}:** ${val}`);
        }
      }
      lines.push('');
      lines.push('</details>');
    }

    return lines.join('\n');
  }

  // ── Case 3: Intermediate turn — present the next question ───────────
  const nextQ = result.nextQuestion;
  if (!nextQ) {
    // Edge case: no question but also not complete
    lines.push('Session state is unclear. You can provide more data or use `forceEstimate: true` to proceed.');
    return lines.join('\n');
  }

  // Phase progress indicator
  const phaseOrder = ['identity', 'classification', 'characteristics', 'market_signals', 'ready'];
  const currentIdx = phaseOrder.indexOf(result.phase);
  const totalPhases = phaseOrder.length - 1; // exclude 'ready'
  lines.push(`### Evolution Estimation — Phase ${currentIdx + 1}/${totalPhases}: ${formatPhaseName(result.phase)}`);
  lines.push('');

  // Progress bar
  const progressPct = Math.round((currentIdx / totalPhases) * 100);
  const filled = Math.round(progressPct / 10);
  const progressBar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
  lines.push(`Progress: [${progressBar}] ${progressPct}%`);
  lines.push('');

  // Main question
  lines.push(`**${nextQ.prompt}**`);
  lines.push('');

  // Hints as guidance
  if (nextQ.hints && nextQ.hints.length > 0) {
    for (const hint of nextQ.hints) {
      if (hint.startsWith('\u2713')) {
        lines.push(`  ${hint}`);
      } else if (hint === '') {
        lines.push('');
      } else {
        lines.push(`  - ${hint}`);
      }
    }
    lines.push('');
  }

  // Show what we've gathered so far
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

  // Shortcut hint
  lines.push('*Tip: You can say "estimate now" to force estimation with available data, or provide all values at once.*');

  return lines.join('\n');
}

/**
 * Format a phase name into a human-readable label.
 * @param {string} phase
 * @returns {string}
 */
function formatPhaseName(phase: string): string {
  const labels: Record<string, string> = {
    identity: 'Component Identity',
    classification: 'Economic Classification',
    characteristics: 'Maturity Characteristics',
    market_signals: 'Market & Publication Signals',
    ready: 'Ready for Estimation',
  };
  return labels[phase] || phase;
}
