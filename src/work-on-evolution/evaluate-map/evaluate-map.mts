// Evaluate all components in a .wm Wardley Map file and update evolution positions.
//
// Pipeline:
//   1. Parse the .wm file to extract components
//   2. Classify each component (classification gate)
//   3. Evaluate economic components via estimateEvolution
//   4. Update maturity positions in the .wm content
//   5. Write the updated file
//
// Usage:
//   import { evaluateMapFile } from './evaluate-map.mjs';
//   const result = await evaluateMapFile('maps/myMaps/tea-shop.wm');

import type { McpToolDefinition } from '../../types/mcp.mjs';
import type { ParsedWardleyMap, MapItemEvaluation, EvaluateMapOptions } from '../../types/wm-map.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { classifyComponent } from '../routing/classification-gate.mjs';
import { estimateEvolutionOneShot } from '../estimate-evolution.mjs';
import { logDebug, logInfo, logError } from '../../lib/mcp-notifications.mjs';
import { createMessageResolverFromArgs } from '../../lib/progress-messages.mjs';
import { toErrorMessage, errorCode } from '../../lib/errors.mjs';

// ─── .wm Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a .wm file into structured data.
 *
 * @param {string} content - Raw .wm file content
 * @returns {Object} Parsed map structure
 */
export function parseWardleyMap(content: string): ParsedWardleyMap {
  const lines = content.split('\n');
  const result: ParsedWardleyMap = {
    title: null,
    style: null,
    anchors: [],
    components: [],
    links: [],
    evolves: [],
    notes: [],
    pipelines: [],
    other: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Title
    const titleMatch = trimmed.match(/^title\s+(.+)$/);
    if (titleMatch) {
      result.title = titleMatch[1];
      continue;
    }

    // Style
    const styleMatch = trimmed.match(/^style\s+(.+)$/);
    if (styleMatch) {
      result.style = styleMatch[1];
      continue;
    }

    // Anchor
    const anchorMatch = trimmed.match(/^anchor\s+(.+?)\s*\[([\d.]+),\s*([\d.]+)\]/);
    if (anchorMatch) {
      result.anchors.push({
        name: anchorMatch[1].trim(),
        visibility: parseFloat(anchorMatch[2]),
        maturity: parseFloat(anchorMatch[3]),
        raw: trimmed,
      });
      continue;
    }

    // Component (with optional decorators and label)
    const compMatch = trimmed.match(/^component\s+(.+?)\s*\[([\d.]+),\s*([\d.]+)\](.*)?$/);
    if (compMatch) {
      const name = compMatch[1].trim();
      const rest = compMatch[4] || '';
      const decorators = [];
      const decoMatches = rest.matchAll(/\((\w+)\)/g);
      for (const m of decoMatches) decorators.push(m[1]);

      const labelMatch = rest.match(/label\s*\[([-\d.]+),\s*([-\d.]+)\]/);
      result.components.push({
        name,
        visibility: parseFloat(compMatch[2]),
        maturity: parseFloat(compMatch[3]),
        decorators,
        label: labelMatch ? [parseFloat(labelMatch[1]), parseFloat(labelMatch[2])] : null,
        raw: trimmed,
      });
      continue;
    }

    // Evolve
    const evolveMatch = trimmed.match(/^evolve\s+(.+?)\s+([\d.]+)/);
    if (evolveMatch) {
      result.evolves.push({
        name: evolveMatch[1].trim(),
        target: parseFloat(evolveMatch[2]),
        raw: trimmed,
      });
      continue;
    }

    // Note
    const noteMatch = trimmed.match(/^note\s+\[(.+?)\]\s*\[([\d.]+),\s*([\d.]+)\]/);
    if (noteMatch) {
      result.notes.push({
        text: noteMatch[1],
        visibility: parseFloat(noteMatch[2]),
        maturity: parseFloat(noteMatch[3]),
        raw: trimmed,
      });
      continue;
    }

    // Links (A->B or A+>B)
    const linkMatch = trimmed.match(/^(.+?)\s*->\s*(.+?)(?:\s*;\s*(.+))?$/);
    if (linkMatch) {
      result.links.push({
        from: linkMatch[1].trim(),
        to: linkMatch[2].trim(),
        label: linkMatch[3] || null,
        raw: trimmed,
      });
      continue;
    }

    // Pipeline
    const pipelineMatch = trimmed.match(/^pipeline\s+(.+)/);
    if (pipelineMatch) {
      result.pipelines.push({ raw: trimmed });
      continue;
    }

    result.other.push(trimmed);
  }

  return result;
}

// ─── Component Evaluation ───────────────────────────────────────────────────

/**
 * Evaluate all components in a parsed map.
 *
 * @param {Object} parsedMap - Output from parseWardleyMap()
 * @param {Object} [options={}]
 * @param {string} [options.strategy='all'] - Evaluation strategy
 * @param {string} [options.context] - Additional context for evaluation
 * @returns {Promise<{evaluations: Array, summary: Object}>}
 */
export async function evaluateMapComponents(parsedMap: ParsedWardleyMap, options: EvaluateMapOptions = {}): Promise<{ evaluations: MapItemEvaluation[]; summary: any }> {
  const { strategy = 'all', context = parsedMap.title || '', msg } = options;
  const TOOL = 'evaluateMap';
  const evaluations: MapItemEvaluation[] = [];

  // Evaluate anchors + components
  const allItems = [
    ...parsedMap.anchors.map((a: any) => ({ ...a, type: 'anchor' })),
    ...parsedMap.components.map((c: any) => ({ ...c, type: 'component' })),
  ];

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];

    // Debug: per-component progress
    if (msg) {
      logDebug(TOOL, msg('step.evaluation.progress', {
        current: i + 1,
        total: allItems.length,
        component: item.name,
      }));
    }

    // Classification gate
    const classification = classifyComponent(item.name, context);

    // Debug: classification result
    if (msg) {
      logDebug(TOOL, msg('step.classification', {
        component: item.name,
        space: classification.space,
      }));
    }

    if (classification.requiresReQuestion) {
      // Debug: skipped component
      if (msg) {
        logDebug(TOOL, msg('step.evaluation.skipped', {
          component: item.name,
          reason: classification.space,
        }));
      }
      evaluations.push({
        name: item.name,
        type: item.type,
        originalMaturity: item.maturity,
        newMaturity: null,
        classification: classification.space,
        strategies: null,
        skipped: true,
        reason: classification.reason,
      });
      continue;
    }

    // Evaluate via estimateEvolution
    try {
      const result = await estimateEvolutionOneShot({
        name: item.name,
        description: context,
        strategy,
      });

      const stratResults: Record<string, any> = {};
      let bestEvolution = item.maturity;

      if (result.evaluations) {
        for (const [method, ev] of Object.entries(result.evaluations) as [string, any][]) {
          if (!ev.error) {
            stratResults[method] = { evolution: ev.evolution, confidence: ev.confidence };
          }
        }

        // Pick the strategy with highest confidence
        const best = (Object.entries(stratResults) as [string, any][])
          .filter(([, v]) => v.evolution >= 0 && v.evolution <= 1)
          .sort((a, b) => b[1].confidence - a[1].confidence)[0];

        if (best) {
          bestEvolution = Math.round(best[1].evolution * 100) / 100;
          // Debug: best evolution picked
          if (msg) {
            logDebug(TOOL, msg('step.evaluation.bestpick', {
              component: item.name,
              evolution: bestEvolution,
              strategy: best[0],
              confidence: best[1].confidence,
            }));
          }
        }
      }

      evaluations.push({
        name: item.name,
        type: item.type,
        originalMaturity: item.maturity,
        newMaturity: bestEvolution,
        delta: Math.round((bestEvolution - item.maturity) * 100) / 100,
        classification: 'economic',
        strategies: stratResults,
        skipped: false,
      });
    } catch (err) {
      logError(TOOL, msg
        ? msg('error.generic', { tool: TOOL, error: toErrorMessage(err) })
        : `Error evaluating "${item.name}": ${toErrorMessage(err)}`);
      evaluations.push({
        name: item.name,
        type: item.type,
        originalMaturity: item.maturity,
        newMaturity: null,
        classification: 'economic',
        strategies: null,
        skipped: true,
        reason: toErrorMessage(err),
      });
    }
  }

  const evaluated = evaluations.filter(e => !e.skipped);
  const skipped = evaluations.filter(e => e.skipped);

  // Debug: evaluation summary (mirrors estimateEvolution pattern)
  if (msg) {
    logDebug(TOOL, msg('step.evaluation.summary', {
      evaluated: evaluated.length,
      skipped: skipped.length,
      total: allItems.length,
    }));
  }

  return {
    evaluations,
    summary: {
      total: allItems.length,
      evaluated: evaluated.length,
      skipped: skipped.length,
      avgDelta: evaluated.length > 0
        ? Math.round(evaluated.reduce((s, e) => s + Math.abs(e.delta || 0), 0) / evaluated.length * 100) / 100
        : 0,
    },
  };
}

// ─── .wm Content Update ────────────────────────────────────────────────────

/**
 * Update maturity positions in .wm content based on evaluations.
 *
 * @param {string} originalContent - Original .wm file content
 * @param {Array} evaluations - Output from evaluateMapComponents()
 * @returns {string} Updated .wm content
 */
export function updateWmContent(originalContent: string, evaluations: MapItemEvaluation[]): string {
  let content = originalContent;

  for (const ev of evaluations) {
    if (ev.skipped || ev.newMaturity === null) continue;

    // Update component lines
    const compRegex = new RegExp(
      `^(component\\s+${escapeRegex(ev.name)}\\s*\\[${escapeRegex(String(ev.originalMaturity))},\\s*)([\\d.]+)(\\].*)$`,
      'gm'
    );
    content = content.replace(compRegex, `$1${ev.newMaturity.toFixed(2)}$3`);

    // Also try matching with visibility first (correct OWM format: [visibility, maturity])
    const compRegex2 = new RegExp(
      `^(component\\s+${escapeRegex(ev.name)}\\s*\\[[\\d.]+,\\s*)([\\d.]+)(\\].*)$`,
      'gm'
    );
    content = content.replace(compRegex2, `$1${ev.newMaturity.toFixed(2)}$3`);

    // Update anchor lines
    const anchorRegex = new RegExp(
      `^(anchor\\s+${escapeRegex(ev.name)}\\s*\\[[\\d.]+,\\s*)([\\d.]+)(\\].*)$`,
      'gm'
    );
    content = content.replace(anchorRegex, `$1${ev.newMaturity.toFixed(2)}$3`);
  }

  return content;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Evaluation Report ──────────────────────────────────────────────────────

/**
 * Format a markdown evaluation report.
 *
 * @param {Array} evaluations
 * @param {Object} summary
 * @returns {string} Markdown report
 */
// any: summary carries a heterogeneous bag of stats (avgDelta, byClassification, ...)
export function formatEvaluationReport(evaluations: MapItemEvaluation[], summary: any): string {
  const lines: string[] = [];
  lines.push('## Evaluation Report\n');
  lines.push(`| Component | Original | New | Delta | Status |`);
  lines.push(`|-----------|----------|-----|-------|--------|`);

  for (const ev of evaluations) {
    if (ev.skipped) {
      lines.push(`| ${ev.name} | ${ev.originalMaturity} | - | - | ${ev.classification} (skipped) |`);
    } else {
      const delta = ev.delta ?? 0;
      const arrow = delta > 0.05 ? ' >>>' : delta < -0.05 ? ' <<<' : '';
      lines.push(`| ${ev.name} | ${ev.originalMaturity} | ${ev.newMaturity} | ${delta > 0 ? '+' : ''}${delta} | ${arrow} |`);
    }
  }

  lines.push('');
  lines.push(`**Summary:** ${summary.evaluated}/${summary.total} evaluated, ${summary.skipped} skipped, avg delta: ${summary.avgDelta}`);

  return lines.join('\n');
}

// ─── High-level File Function ───────────────────────────────────────────────

/**
 * Evaluate a .wm file and optionally update it.
 *
 * @param {string} filePath - Path to the .wm file
 * @param {Object} [options={}]
 * @param {string} [options.strategy='all']
 * @param {boolean} [options.updateFile=true]
 * @returns {Promise<{evaluations, summary, report, updatedContent, filePath}>}
 */
// any: result is a heterogeneous bag (filePath, updated, evaluations, summary, ...)
export async function evaluateMapFile(filePath: string, options: EvaluateMapOptions = {}): Promise<any> {
  const { strategy = 'all', updateFile = true } = options;
  const TOOL = 'evaluateMap';

  // ── Localized message resolver ──────────────────────────────────────
  const { msg, lang } = createMessageResolverFromArgs({ filePath });

  // Info-level: tool start (localized)
  logInfo(TOOL, msg('tool.start.map', { tool: TOOL, filePath }));
  const t0 = Date.now();

  // Debug: strategy selection
  logDebug(TOOL, `Strategy: "${strategy}", updateFile: ${updateFile}, lang: ${lang}`);

  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    logError(TOOL, msg('error.parse', { error: `Cannot read file "${filePath}": ${toErrorMessage(err)}` }));
    throw err;
  }

  const parsedMap = parseWardleyMap(content);

  // Debug: parsing complete
  const componentCount = parsedMap.anchors.length + parsedMap.components.length;
  logDebug(TOOL, msg('step.parsing', { count: componentCount }));

  const { evaluations, summary } = await evaluateMapComponents(parsedMap, { strategy, msg });
  const report = formatEvaluationReport(evaluations, summary);

  let updatedContent = content;
  if (updateFile) {
    logDebug(TOOL, msg('step.file.update', { count: summary.evaluated }));
    updatedContent = updateWmContent(content, evaluations);
    await writeFile(filePath, updatedContent, 'utf-8');
  }

  // Info-level: tool end (localized)
  const duration = Date.now() - t0;
  logInfo(TOOL, msg('tool.end.map', { tool: TOOL, filePath, count: summary.evaluated, duration }));

  return { evaluations, summary, report, updatedContent, filePath };
}

// ─── MCP Tool Definition ────────────────────────────────────────────────────

export const EVALUATE_MAP_TOOL: McpToolDefinition = {
  name: 'evaluateMap',
  description:
    'Evaluate all components in a .wm Wardley Map file, estimate their evolution positions, ' +
    'and update the file with new maturity values. Uses the classification gate to skip non-economic ' +
    'components and runs pluggable evaluation strategies on economic ones.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the .wm file to evaluate',
      },
      strategy: {
        type: 'string',
        description: 'Evaluation strategy (default: all)',
        default: 'all',
      },
      updateFile: {
        type: 'boolean',
        description: 'Whether to update the .wm file with new positions (default: true)',
        default: true,
      },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
};

/**
 * MCP tool handler for evaluateMap.
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>}
 */
export async function handleEvaluateMap(args: Record<string, unknown>): Promise<unknown> {
  return evaluateMapFile(args.filePath as string, {
    strategy: args.strategy as string | undefined,
    updateFile: args.updateFile as boolean | undefined,
  });
}

// ─── Self-test ──────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== evaluate-map.mjs self-test ===\n');

  // Test parser
  console.log('--- Test: .wm parser ---');
  const testWm = `title Tea Shop

anchor Business [0.95, 0.63]

component Cup of Tea [0.79, 0.61]
component Cup [0.73, 0.78] (buy)
component Tea [0.63, 0.45]
component Hot Water [0.52, 0.82]
component Kettle [0.32, 0.33] (inertia) label [-48, -13]
component Power [0.11, 0.89]

Business->Cup of Tea
Cup of Tea->Cup
Cup of Tea->Tea
Cup of Tea->Hot Water
Hot Water->Kettle
Kettle->Power

style wardley`;

  const parsed = parseWardleyMap(testWm);
  console.log(`  Title: ${parsed.title}`);
  console.log(`  Anchors: ${parsed.anchors.length}`);
  console.log(`  Components: ${parsed.components.length}`);
  console.log(`  Links: ${parsed.links.length}`);
  console.log(`  Style: ${parsed.style}`);

  for (const c of parsed.components) {
    console.log(`    ${c.name} [${c.visibility}, ${c.maturity}] ${c.decorators.length ? `(${c.decorators.join(', ')})` : ''}`);
  }

  console.log('\n=== parser test complete ===');
}
