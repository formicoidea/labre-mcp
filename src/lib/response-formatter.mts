// Response formatter: transforms raw evaluation API results into
// user-friendly conversational output with evolution stage, confidence,
// and reasoning.
//
// Handles three output scenarios:
//   1. Economic component evaluated → stage name, confidence bar, reasoning per strategy
//   2. Non-economic component (social/common good) → re-questioning prompts
//   3. Error / partial results → graceful degradation with actionable guidance
//
// Evolution stage mapping follows the Wardley Map x-axis:
//   0.00–0.17  Genesis         (novel, uncertain)
//   0.17–0.40  Custom-Built    (emerging, divergent)
//   0.40–0.70  Product (+rental)(converging, feature-rich)
//   0.70–1.00  Commodity (+utility) (standardised, invisible)
//   (evolution is always in [0, 1] via geometric projection)

// ─── Evolution Stage Mapping ────────────────────────────────────────────────

export interface EvolutionStage {
  name: string;
  shortName: string;
  descriptor: string;
  rangeMin: number;
  rangeMax: number;
}

/**
 * @typedef {Object} EvolutionStage
 * @property {string} name       - Stage label (e.g. "Product (+rental)")
 * @property {string} shortName  - Short label (e.g. "Product")
 * @property {string} descriptor - Human-readable trait (e.g. "converging, feature-differentiated")
 * @property {number} rangeMin   - Lower bound (inclusive)
 * @property {number} rangeMax   - Upper bound (exclusive, except last)
 */

const EVOLUTION_STAGES: EvolutionStage[] = [
  {
    name: 'Genesis',
    shortName: 'Genesis',
    descriptor: 'novel, poorly understood, high uncertainty',
    rangeMin: 0.00,
    rangeMax: 0.17,
  },
  {
    name: 'Custom-Built',
    shortName: 'Custom',
    descriptor: 'emerging, divergent implementations, requires expertise',
    rangeMin: 0.17,
    rangeMax: 0.40,
  },
  {
    name: 'Product (+rental)',
    shortName: 'Product',
    descriptor: 'converging, feature-differentiated, increasing competition',
    rangeMin: 0.40,
    rangeMax: 0.70,
  },
  {
    name: 'Commodity (+utility)',
    shortName: 'Commodity',
    descriptor: 'standardised, well-defined, utility-like, volume operations',
    rangeMin: 0.70,
    rangeMax: 1.00,
  },
];

/**
 * Map an evolution value (0–1) to its Wardley stage.
 *
 * @param {number} evolution - Evolution value
 * @returns {EvolutionStage & { position: string }}
 */
export function evolutionToStage(evolution: number): EvolutionStage & { position: string } {
  for (const stage of EVOLUTION_STAGES) {
    if (evolution >= stage.rangeMin && evolution < stage.rangeMax) {
      return { ...stage, position: evolution.toFixed(3) };
    }
  }

  // Edge case: exactly 1.0
  return { ...EVOLUTION_STAGES[3], position: evolution.toFixed(3) };
}

// ─── Confidence Formatting ──────────────────────────────────────────────────

/**
 * Format a confidence value as a descriptive label + visual bar.
 *
 * @param {number} confidence - Confidence 0–1
 * @returns {{ label: string, bar: string, percentage: string }}
 */
export function formatConfidence(confidence: number): { label: string; bar: string; percentage: string } {
  const pct = Math.round(confidence * 100);
  const filledBlocks = Math.round(confidence * 10);
  const bar = '█'.repeat(filledBlocks) + '░'.repeat(10 - filledBlocks);

  let label;
  if (confidence >= 0.85) label = 'Very high';
  else if (confidence >= 0.70) label = 'High';
  else if (confidence >= 0.50) label = 'Moderate';
  else if (confidence >= 0.30) label = 'Low';
  else label = 'Very low';

  return { label, bar, percentage: `${pct}%` };
}

// ─── Strategy Reasoning ─────────────────────────────────────────────────────

/**
 * Generate a human-readable reasoning sentence for a strategy result.
 *
 * @param {string} method - Strategy method identifier
 * @param {Object} result - EvolutionResult { evolution, confidence, method }
 * @param {Object} [component] - Original component input (for context)
 * @returns {string} Reasoning sentence
 */
// any: result/component shapes vary across strategies (capability vs solution vs anchor)
export function strategyReasoning(method: string, result: any, component: any = {}) {
  const stage = evolutionToStage(result.evolution);

  const reasoningMap = {
    's-curve': () => {
      const cert = component.certitude != null ? component.certitude.toFixed(2) : '?';
      const ubi = component.ubiquity != null ? component.ubiquity.toFixed(2) : '?';
      return (
        `The dual sigmoid model projects certitude (${cert}) × ubiquity (${ubi}) ` +
        `onto the S-curve center line, placing this component in the **${stage.name}** stage. ` +
        `This mathematical model works best when both inputs are well-calibrated.`
      );
    },

    'publication-analysis': () => {
      const parts = [];
      if (component.wonder != null) parts.push(`wonder=${component.wonder}`);
      if (component.build != null) parts.push(`build=${component.build}`);
      if (component.operate != null) parts.push(`operate=${component.operate}`);
      if (component.usage != null) parts.push(`usage=${component.usage}`);
      const distribution = parts.length > 0 ? parts.join(', ') : 'provided distribution';
      return (
        `Publication type analysis (${distribution}) indicates the dominant discourse ` +
        `is consistent with the **${stage.name}** stage — ${stage.descriptor}.`
      );
    },

    'timeline-benchmark': () =>
      `Historical benchmark comparison places "${component.name || 'this component'}" ` +
      `at the **${stage.name}** stage based on known evolution timelines of similar components.`,

    'llm-direct': () =>
      `Direct LLM assessment positions this component in the **${stage.name}** stage ` +
      `based on semantic understanding of its description and market context.`,

    'logprob-distribution': () =>
      `Log-probability distribution analysis of stage tokens suggests ` +
      `the **${stage.name}** stage with the highest probability mass.`,

    'cpc-evolution': () =>
      `Patent CPC classification analysis positions this component in the **${stage.name}** stage ` +
      `based on patent filing patterns and technology classification codes.`,

    'properties': () => buildSolutionPropertiesReasoning(result, stage),
    'solution-properties': () => buildSolutionPropertiesReasoning(result, stage),
  };

  const generator = (reasoningMap as Record<string, () => string>)[method];
  if (generator) return generator();

  // Handle solution: prefixed methods (parallel mode key collision resolution)
  if (method.startsWith('solution:')) {
    const baseMethod = method.replace(/^solution:/, '');
    const baseGenerator = (reasoningMap as Record<string, () => string>)[baseMethod];
    if (baseGenerator) return baseGenerator();
  }

  // Fallback for unknown/new strategies (including dynamically added solution strategies)
  // If the result has properties, it's likely a solution strategy
  if (result.properties && Array.isArray(result.properties) && result.properties.length > 0) {
    return buildSolutionPropertiesReasoning(result, stage);
  }

  return `Strategy "${method}" estimates the component at the **${stage.name}** stage (${stage.descriptor}).`;
}

// ─── Solution Properties Reasoning ─────────────────────────────────────────

/**
 * Build reasoning text for solution property-based evaluation.
 *
 * @param {Object} result - Evaluation result with optional properties, phaseDistribution, meanPhase
 * @param {Object} stage  - Wardley stage from evolutionToStage()
 * @returns {string} Reasoning sentence
 */
// any: result is a SolutionEvolutionResult-like bag with optional dist/dominant fields
function buildSolutionPropertiesReasoning(result: any, stage: EvolutionStage): string {
  const propCount = result.properties?.length || 12;
  const parts = [
    `12-property Wardley evolution evaluation across ${propCount} characteristics ` +
    `(Market, Knowledge, Perception, etc.) places this solution in the **${stage.name}** stage — ` +
    `${stage.descriptor}.`,
  ];

  // Add phase distribution insight if available (from assembler enrichment)
  if (result.phaseDistribution) {
    const dist = result.phaseDistribution;
    const phaseLabels: Record<string, string> = { 1: 'Genesis', 2: 'Custom', 3: 'Product', 4: 'Commodity' };
    const nonZero = Object.entries(dist)
      .filter(([, count]) => (count as number) > 0)
      .map(([phase, count]) => `${count}× ${phaseLabels[phase]}`)
      .join(', ');
    if (nonZero) {
      parts.push(`Phase distribution: ${nonZero}.`);
    }
  }

  // Add dominant phase if available
  if (result.dominantPhase && result.dominantPhase.count > 0) {
    const ratio = Math.round((result.dominantPhase.count / propCount) * 100);
    if (ratio >= 50) {
      parts.push(
        `Dominant phase: ${result.dominantPhase.label} (${ratio}% of properties).`
      );
    }
  }

  return parts.join(' ');
}

// ─── Single Strategy Result Block ───────────────────────────────────────────

/**
 * Format a single strategy evaluation result into a markdown block.
 *
 * @param {string} method - Strategy method identifier
 * @param {Object} evalResult - { evolution, confidence, method } or { error }
 * @param {Object} [component] - Original component input
 * @returns {string} Markdown block
 */
// any: evalResult is heterogeneous (EvolutionResult|SolutionEvolutionResult|{error}); component is loose
export function formatStrategyResult(method: string, evalResult: any, component: any = {}): string {
  if (evalResult.error) {
    return `**${method}**: ⚠️ ${evalResult.error}`;
  }

  const stage = evolutionToStage(evalResult.evolution);
  const conf = formatConfidence(evalResult.confidence);
  const reasoning = strategyReasoning(method, evalResult, component);

  const lines = [
    `**${method}**`,
    `  Evolution: **${stage.position}** → **${stage.name}**`,
    `  Confidence: ${conf.bar} ${conf.percentage} (${conf.label})`,
    `  ${reasoning}`,
  ];

  // Solution strategy: show per-property phase breakdown if available
  if (evalResult.properties && Array.isArray(evalResult.properties) && evalResult.properties.length > 0) {
    lines.push('');
    lines.push('  Property breakdown:');
    const phaseLabels: Record<number, string> = { 1: 'Genesis', 2: 'Custom', 3: 'Product', 4: 'Commodity' };
    for (const prop of evalResult.properties) {
      const label = prop.label || phaseLabels[prop.phase as number] || `Phase ${prop.phase}`;
      const reasonSuffix = prop.reason ? ` — ${prop.reason}` : '';
      lines.push(`    - ${prop.property}: **${label}** (phase ${prop.phase})${reasonSuffix}`);
    }

    // Show summary statistics if available (from assembler enrichment)
    if (evalResult.meanPhase != null || evalResult.stage) {
      lines.push('');
      const summaryParts = [];
      if (evalResult.meanPhase != null) {
        summaryParts.push(`Mean phase: ${evalResult.meanPhase}`);
      }
      if (evalResult.stage) {
        summaryParts.push(`Overall stage: ${evalResult.stage}`);
      }
      if (evalResult.confidenceMetadata?.coverage != null) {
        const coveragePct = Math.round(evalResult.confidenceMetadata.coverage * 100);
        summaryParts.push(`Coverage: ${coveragePct}%`);
      }
      if (summaryParts.length > 0) {
        lines.push(`  *${summaryParts.join(' | ')}*`);
      }
    }
  }

  return lines.join('\n');
}

// ─── Full Response Formatter ────────────────────────────────────────────────

/**
 * Format a complete evaluation API response into conversational markdown.
 *
 * Accepts the result from:
 *   - handleEstimateEvolution() (MCP tool)
 *   - estimateEvolutionOneShot() (one-shot API)
 *   - estimateEvolutionConversational() (conversational API)
 *   - handleSkillInvocation() (skill handler, which adds parsedInput/availableStrategies)
 *
 * @param {Object} result - API response object
 * @param {Object} [options] - Formatting options
 * @param {Object} [options.component] - Original component input for richer reasoning
 * @param {boolean} [options.compact] - If true, use shorter format
 * @returns {string} Markdown-formatted conversational output
 */
// any: result is a RoutedResponse-like bag; options carry compact/locale tunables
export function formatResponse(result: any, options: any = {}): string {
  const component = options.component || result.parsedInput || {};
  const compact = options.compact || false;
  const name = component.name || result.classification?.space || 'Unknown';
  const lines = [];

  // ── Header ──
  lines.push(`## Evolution Estimation: ${name}`);
  lines.push('');

  // ── Classification ──
  const cls = result.classification;
  if (cls) {
    lines.push(`**Classification:** ${formatSpaceName(cls.space)}`);
    if (cls.reason && !compact) {
      lines.push(`> ${cls.reason}`);
    }
    lines.push('');
  }

  // ── Routing metadata (solution vs capability detection) ──
  if (result.routing && !compact) {
    lines.push(formatRoutingBlock(result.routing));
    lines.push('');
  }

  // ── Wardley component type metadata (activity/practice/data/knowledge) ──
  if (result.wardleyType && !compact) {
    lines.push(formatWardleyTypeBlock(result.wardleyType));
    lines.push('');
  }

  // ── Non-economic: re-questioning ──
  if (result.reQuestions && result.reQuestions.length > 0) {
    lines.push(formatReQuestioningBlock(result.reQuestions, name, cls));
    return lines.join('\n');
  }

  // ── Economic: evaluation results ──
  if (result.evaluations) {
    const entries = Object.entries(result.evaluations);
    const successful = entries.filter(([, ev]) => !(ev as any).error);
    const errors = entries.filter(([, ev]) => (ev as any).error);

    if (successful.length === 0 && errors.length > 0) {
      // All strategies errored
      lines.push('### ⚠️ No Successful Evaluations');
      lines.push('');
      lines.push('All strategies encountered errors:');
      lines.push('');
      for (const [method, ev] of errors) {
        lines.push(`- **${method}**: ${(ev as any).error}`);
      }
      lines.push('');
      lines.push('*Try providing more parameters (certitude, ubiquity, publication proportions) or use a specific strategy.*');
    } else {
      // At least one success
      if (compact) {
        lines.push(formatCompactResults(successful, errors, component));
      } else {
        lines.push(formatDetailedResults(successful, errors, component));
      }
    }
  }

  // ── Conversational mode metadata ──
  if (result.mode === 'conversational' && result.phase !== 'complete') {
    lines.push('');
    lines.push(formatConversationalGuidance(result));
  }

  // ── Available strategies footer ──
  if (result.availableStrategies && !compact) {
    lines.push('');
    lines.push(`*Available strategies: ${result.availableStrategies.join(', ')}*`);
  }

  return lines.join('\n');
}

// ─── Internal Formatting Helpers ────────────────────────────────────────────

/**
 * Format a space name for display.
 * @param {string} space
 * @returns {string}
 */
function formatSpaceName(space: string): string {
  const names: Record<string, string> = {
    economic: 'Economic Space (market-driven)',
    social_good: 'Social Good (naturally available)',
    common_good: 'Common Good (collectively managed)',
  };
  return names[space] || space;
}

/**
 * Format the re-questioning block for non-economic components.
 *
 * @param {string[]} reQuestions
 * @param {string} name
 * @param {Object} classification
 * @returns {string}
 */
function formatReQuestioningBlock(reQuestions: string[], name: string, classification: { space: string; reason: string }): string {
  const spaceLabel = classification?.space === 'social_good' ? 'social good' : 'common good';
  const lines = [
    `### ⚠️ Component Outside Economic Space`,
    '',
    `**"${name}"** has been classified as a **${spaceLabel}** — it falls outside the ` +
    `standard Wardley Map evolution axis (Genesis → Commodity).`,
    '',
    `Evolution evaluation is **not applicable** for this type of component. ` +
    `Instead, please consider the following questions to reframe your analysis:`,
    '',
  ];

  for (let i = 0; i < reQuestions.length; i++) {
    lines.push(`${i + 1}. ${reQuestions[i]}`);
  }

  lines.push('');
  lines.push(
    `💡 *Tip: If you meant a commodified or market version of this concept ` +
    `(e.g., "bottled oxygen" instead of "air"), re-specify the component with its economic context.*`
  );

  return lines.join('\n');
}

/**
 * Format Wardley component type metadata into a markdown line.
 *
 * The 4 Wardley component types are:
 *   - Activity: things you do (manage, process, deliver…)
 *   - Practice: how you do things (methodologies, standards…)
 *   - Data: information, metrics, records, signals
 *   - Knowledge: expertise, skills, understanding, models
 *
 * @param {{ type: string, confidence: number, reason: string }} wardleyType
 * @returns {string} Markdown line
 */
// any: wardleyType is the heterogeneous output of classifyWardleyType
function formatWardleyTypeBlock(wardleyType: any): string {
  const typeLabels: Record<string, string> = {
    activity: 'Activity (what you do)',
    practice: 'Practice (how you do it)',
    data: 'Data (information/records)',
    knowledge: 'Knowledge (expertise/understanding)',
  };

  const label = typeLabels[wardleyType.type as string] || wardleyType.type;
  const conf = formatConfidence(wardleyType.confidence);

  return `**Wardley Component Type:** ${label} — ${conf.percentage} confidence (${wardleyType.reason})`;
}

/**
 * Format routing metadata (solution vs capability detection) into a markdown block.
 *
 * Shows the component type detection result, confidence, method used,
 * and which strategy pipeline(s) were dispatched.
 *
 * @param {Object} routing - Routing metadata from estimate-evolution.mjs
 * @param {string} routing.type - 'solution' or 'capability'
 * @param {number} routing.confidence - Detection confidence (0–1)
 * @param {string} routing.method - Detection method ('known-solution', 'known-capability', 'heuristic', 'naming+llm', etc.)
 * @param {string} routing.evalMode - 'exclusive' or 'parallel'
 * @param {boolean} routing.usedSolutionStrategies - Whether solution strategies ran
 * @param {boolean} routing.usedCapabilityStrategies - Whether capability strategies ran
 * @param {boolean} [routing.verified] - Whether dual-verification confirmed the classification
 * @param {string[]} [routing.tiersUsed] - Verification tiers invoked (e.g. ['naming', 'llm'])
 * @returns {string} Markdown block
 */
// any: routing carries diverse fields from RoutingMetadata + dispatch extensions
function formatRoutingBlock(routing: any): string {
  const typeLabel = routing.type === 'solution'
    ? 'Named Solution (product/platform)'
    : 'Abstract Capability (activity/practice)';

  const conf = formatConfidence(routing.confidence);

  const methodLabels: Record<string, string> = {
    'known-solution': 'dictionary match (known solution)',
    'known-capability': 'dictionary match (known capability)',
    'heuristic': 'naming convention heuristics',
    'naming': 'naming convention',
    'naming+llm': 'naming + LLM semantic classification',
    'naming+web-search': 'naming + web search evidence',
    'naming+llm+web-search': 'naming + LLM + web search (full pipeline)',
  };
  const methodLabel = methodLabels[routing.method as string] || routing.method;

  const lines = [
    `**Component Type:** ${typeLabel}`,
    `  Detection: ${conf.bar} ${conf.percentage} confidence via ${methodLabel}`,
  ];

  // Show which strategy pipelines were dispatched
  const pipelines = [];
  if (routing.usedSolutionStrategies) pipelines.push('solution (12-property evaluation)');
  if (routing.usedCapabilityStrategies) pipelines.push('capability (s-curve, publication, LLM, etc.)');

  if (pipelines.length > 0) {
    const modeLabel = routing.evalMode === 'parallel' ? 'parallel' : 'exclusive';
    lines.push(`  Evaluation: ${pipelines.join(' + ')} [${modeLabel} mode]`);
  }

  // Show verification status if dual-verification was used
  if (routing.verified != null) {
    const verifiedLabel = routing.verified ? 'confirmed' : 'unverified (low agreement)';
    const tiers = routing.tiersUsed?.join(' → ') || 'unknown';
    lines.push(`  Verification: ${verifiedLabel} (tiers: ${tiers})`);
  }

  return lines.join('\n');
}

/**
 * Format detailed results with reasoning for each strategy.
 *
 * @param {Array} successful - [[method, result], ...]
 * @param {Array} errors - [[method, result], ...]
 * @param {Object} component
 * @returns {string}
 */
// any: successful/errors arrays mix strategy result entries; component is loose
function formatDetailedResults(successful: any[], errors: any[], component: any): string {
  const lines = [];

  // Consensus summary (if multiple strategies)
  if (successful.length > 1) {
    lines.push(formatConsensus(successful));
    lines.push('');
  }

  lines.push('### Strategy Results');
  lines.push('');

  for (const [method, ev] of successful) {
    lines.push(formatStrategyResult(method, ev, component));
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push('### Strategies with Errors');
    lines.push('');
    for (const [method, ev] of errors) {
      lines.push(formatStrategyResult(method, ev, component));
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format compact results as a table.
 *
 * @param {Array} successful
 * @param {Array} errors
 * @param {Object} component
 * @returns {string}
 */
// any: same shapes as formatDetailedResults — compact variant
function formatCompactResults(successful: any[], errors: any[], component: any): string {
  const lines = [];

  lines.push('| Strategy | Evolution | Stage | Confidence |');
  lines.push('|----------|-----------|-------|------------|');

  for (const [method, ev] of successful) {
    const stage = evolutionToStage(ev.evolution);
    const conf = formatConfidence(ev.confidence);
    lines.push(`| ${method} | ${stage.position} | ${stage.shortName} | ${conf.percentage} |`);
  }

  for (const [method, ev] of errors) {
    lines.push(`| ${method} | — | — | ⚠️ ${ev.error} |`);
  }

  // One-line consensus
  if (successful.length > 1) {
    const evolutions = successful.map(([, ev]) => ev.evolution);
    const avg = evolutions.reduce((a, b) => a + b, 0) / evolutions.length;
    const avgStage = evolutionToStage(avg);
    lines.push('');
    lines.push(`**Consensus:** ~${avg.toFixed(3)} (${avgStage.name})`);
  }

  return lines.join('\n');
}

/**
 * Format a consensus summary across multiple strategies.
 *
 * @param {Array} successful - [[method, result], ...]
 * @returns {string}
 */
// any: successful is a list of strategy result entries
function formatConsensus(successful: any[]): string {
  const evolutions = successful.map(([, ev]) => ev.evolution);
  const confidences = successful.map(([, ev]) => ev.confidence);

  const avg = evolutions.reduce((a, b) => a + b, 0) / evolutions.length;
  const min = Math.min(...evolutions);
  const max = Math.max(...evolutions);
  const spread = max - min;
  const avgConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;

  const avgStage = evolutionToStage(avg);
  const minStage = evolutionToStage(min);
  const maxStage = evolutionToStage(max);

  const lines = [
    `### 📊 Consensus Overview`,
    '',
    `**${successful.length} strategies** evaluated — average evolution: **${avg.toFixed(3)}** (${avgStage.name})`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Range | ${min.toFixed(3)} (${minStage.shortName}) – ${max.toFixed(3)} (${maxStage.shortName}) |`,
    `| Spread | ${spread.toFixed(3)} |`,
    `| Average confidence | ${formatConfidence(avgConf).percentage} |`,
  ];

  // Agreement assessment
  if (spread < 0.10) {
    lines.push('');
    lines.push('✅ **Strong agreement** — strategies converge on a narrow range.');
  } else if (spread < 0.25) {
    lines.push('');
    lines.push('🔶 **Moderate agreement** — strategies broadly agree but show some variation.');
  } else {
    lines.push('');
    lines.push('🔴 **Low agreement** — strategies diverge significantly. Consider providing more parameters to reduce uncertainty.');
  }

  return lines.join('\n');
}

/**
 * Format guidance for conversational mode (mid-conversation).
 *
 * @param {Object} result - Conversational result with phase, nextQuestion, summary
 * @returns {string}
 */
// any: result is a guided-turn shape (nextQuestion, phase, gathered, ...)
function formatConversationalGuidance(result: any): string {
  const lines = [];

  if (result.nextQuestion) {
    lines.push(`### Next: ${result.nextQuestion.prompt}`);
    lines.push('');
    if (result.nextQuestion.hints && result.nextQuestion.hints.length > 0) {
      for (const hint of result.nextQuestion.hints) {
        lines.push(`- ${hint}`);
      }
      lines.push('');
    }
  }

  if (result.summary) {
    const { gathered, missing, exchangeCount } = result.summary;
    const gatheredKeys = Object.keys(gathered);
    if (gatheredKeys.length > 0) {
      lines.push(`*Gathered so far (${exchangeCount} exchange(s)):* ${gatheredKeys.join(', ')}`);
    }
    if (missing && missing.length > 0) {
      lines.push(`*Still available to provide:* ${missing.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ─── Self-test ──────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== response-formatter self-test ===\n');

  // Test 1: evolutionToStage mapping
  console.log('--- Test 1: Evolution stage mapping ---');
  const testValues = [0, 0.1, 0.17, 0.3, 0.4, 0.55, 0.7, 0.85, 1.0, -0.1, 1.2];
  for (const v of testValues) {
    const stage = evolutionToStage(v);
    console.log(`  ${v.toFixed(2)} → ${stage.name} (${stage.position})`);
  }
  console.log();

  // Test 2: Confidence formatting
  console.log('--- Test 2: Confidence formatting ---');
  for (const c of [0.1, 0.3, 0.5, 0.7, 0.85, 1.0]) {
    const f = formatConfidence(c);
    console.log(`  ${c.toFixed(1)} → ${f.bar} ${f.percentage} (${f.label})`);
  }
  console.log();

  // Test 3: Strategy reasoning
  console.log('--- Test 3: Strategy reasoning ---');
  const component = { name: 'ERP', certitude: 0.9, ubiquity: 0.85, wonder: 0.02, build: 0.08, operate: 0.25, usage: 0.65 };
  const testResult = { evolution: 0.75, confidence: 0.85, method: 's-curve' };
  console.log(`  s-curve: ${strategyReasoning('s-curve', testResult, component)}`);
  console.log(`  pub: ${strategyReasoning('publication-analysis', testResult, component)}`);
  console.log(`  timeline: ${strategyReasoning('timeline-benchmark', testResult, component)}`);
  console.log();

  // Test 4: Full economic response
  console.log('--- Test 4: Full economic response ---');
  // any: self-test fixture with loose RoutedResponse-like shape
  const economicResult: any = {
    classification: { space: 'economic', reason: '"ERP" classified as economic.', requiresReQuestion: false },
    reQuestions: null,
    evaluations: {
      's-curve': { evolution: 0.752, confidence: 0.85, method: 's-curve' },
      'publication-analysis': { evolution: 0.71, confidence: 0.78, method: 'publication-analysis' },
      'timeline-benchmark': { evolution: 0.80, confidence: 0.65, method: 'timeline-benchmark' },
      'llm-direct': { error: 'LLM call not configured for one-shot mode.' },
    },
    parsedInput: component,
    availableStrategies: ['s-curve', 'publication-analysis', 'timeline-benchmark', 'llm-direct', 'logprob-distribution'],
  };
  console.log(formatResponse(economicResult));
  console.log();

  // Test 5: Re-questioning response
  console.log('--- Test 5: Re-questioning response ---');
  // any: self-test fixture with loose RoutedResponse-like shape
  const socialResult: any = {
    classification: { space: 'social_good', reason: '"Air" is a naturally available resource.', requiresReQuestion: true },
    reQuestions: [
      'Did you mean a commercialized version of this resource (e.g., bottled oxygen, air filtration systems)?',
      'Are you evaluating this as a dependency in a value chain where it has economic implications?',
      'Could this be reframed as a specific product or service within the economic space?',
    ],
    evaluations: null,
    parsedInput: { name: 'Air' },
  };
  console.log(formatResponse(socialResult));
  console.log();

  // Test 6: Compact format
  console.log('--- Test 6: Compact format ---');
  console.log(formatResponse(economicResult, { compact: true }));
  console.log();

  // Test 7: Single strategy
  console.log('--- Test 7: Single strategy ---');
  // any: self-test fixture
  const singleResult: any = {
    classification: { space: 'economic', reason: 'economic component', requiresReQuestion: false },
    reQuestions: null,
    evaluations: {
      's-curve': { evolution: 0.752, confidence: 0.85, method: 's-curve' },
    },
    parsedInput: { name: 'ERP', certitude: 0.9, ubiquity: 0.85 },
  };
  console.log(formatResponse(singleResult));
  console.log();

  // Test 8: All errors
  console.log('--- Test 8: All errors ---');
  // any: self-test fixture
  const errorResult: any = {
    classification: { space: 'economic', reason: 'economic component', requiresReQuestion: false },
    reQuestions: null,
    evaluations: {
      'llm-direct': { error: 'LLM not configured' },
      'logprob-distribution': { error: 'LLM not configured' },
    },
    parsedInput: { name: 'Widget' },
  };
  console.log(formatResponse(errorResult));

  console.log('\n=== response-formatter self-test completed ===');
}
