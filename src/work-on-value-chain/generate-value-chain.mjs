// Generate a Wardley Map .wm file from a business description.
//
// Pipeline:
//   1. LLM decomposes the business context into a value chain
//   2. Each component is evaluated via estimateEvolution (MCP tool)
//   3. A .wm file is generated with correct OWM syntax
//
// Usage:
//   import { generateValueChain } from './generate-value-chain.mjs';
//   const result = await generateValueChain('A tea shop serving customers');

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLLMCall } from '../lib/llm/llm-call.mjs';
import { estimateEvolutionOneShot } from '../work-on-evolution/estimate-evolution.mjs';
import { logDebug, logInfo, logError } from '../lib/mcp-notifications.mjs';
import { createMessageResolverFromArgs } from '../lib/progress-messages.mjs';

// ─── Value Chain Decomposition Prompt ───────────────────────────────────────

const DECOMPOSE_PROMPT = `You are an expert Wardley Mapper.

Given a business description, decompose it into a value chain for a Wardley Map.

Business description: {{description}}

REASONING STEPS:
1. Identify the primary user need (this becomes the anchor)
2. Identify all components needed to satisfy that need
3. For each component, determine its visibility (how visible it is to the user):
   - 0.95: directly visible to the user (anchor level)
   - 0.70-0.90: user-facing components
   - 0.40-0.70: enabling components (middleware, platforms)
   - 0.10-0.40: infrastructure components (compute, storage, networking)
4. Determine dependencies: which components depend on which
5. Give each component a short context description for evolution evaluation

Return a JSON object with this exact structure:
{
  "title": "Map title",
  "anchor": { "name": "User Need Name", "context": "brief context" },
  "components": [
    {
      "name": "Component Name",
      "context": "brief context for evolution evaluation",
      "visibility": 0.75,
      "dependsOn": ["Other Component Name"]
    }
  ]
}

IMPORTANT:
- Component names must be unique
- Visibility must be between 0.05 and 0.95
- dependsOn references must match exact component names
- The anchor is NOT listed in components
- Include 5-15 components for a meaningful map
- Return ONLY the JSON, no markdown fences or extra text`;

// ─── .wm File Generation ────────────────────────────────────────────────────

/**
 * Generate OWM .wm content from a decomposed value chain with evaluated positions.
 *
 * @param {Object} chain - Decomposed value chain
 * @param {Object<string, number>} evolutions - Component name → evolution score
 * @returns {string} Valid .wm file content
 */
function generateWmContent(chain, evolutions) {
  const lines = [];

  // Title
  lines.push(`title ${chain.title}`);
  lines.push('');

  // Anchor — high visibility, maturity from evaluation or default
  const anchorEvo = evolutions[chain.anchor.name] ?? 0.5;
  lines.push(`anchor ${chain.anchor.name} [0.95, ${anchorEvo.toFixed(2)}]`);
  lines.push('');

  // Components sorted by visibility (highest first)
  const sorted = [...chain.components].sort((a, b) => b.visibility - a.visibility);
  for (const comp of sorted) {
    const evo = evolutions[comp.name] ?? 0.5;
    lines.push(`component ${comp.name} [${comp.visibility.toFixed(2)}, ${evo.toFixed(2)}]`);
  }
  lines.push('');

  // Links — anchor to top-level components
  const topLevel = chain.components.filter(c => c.visibility >= 0.70);
  for (const comp of topLevel) {
    lines.push(`${chain.anchor.name}->${comp.name}`);
  }

  // Links — component dependencies
  for (const comp of chain.components) {
    if (comp.dependsOn) {
      for (const dep of comp.dependsOn) {
        lines.push(`${comp.name}->${dep}`);
      }
    }
  }
  lines.push('');

  lines.push('style wardley');

  return lines.join('\n');
}

// ─── Filename Generation ────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Generate a complete Wardley Map .wm file from a business description.
 *
 * @param {string} description - Business description
 * @param {Object} [options={}]
 * @param {string} [options.filename] - Output filename (without extension)
 * @param {string} [options.outputDir='maps/myMaps'] - Output directory
 * @param {string} [options.strategy='timeline-benchmark'] - Evolution evaluation strategy
 * @returns {Promise<{wmContent: string, filePath: string, components: Array, evaluations: Object}>}
 */
export async function generateValueChain(description, options = {}) {
  const {
    filename,
    outputDir = 'maps/myMaps',
    strategy = 'timeline-benchmark',
  } = options;

  const TOOL = 'generateValueChain';

  // ── Localized message resolver ──────────────────────────────────────
  const { msg, lang } = createMessageResolverFromArgs({ description });

  // Info-level: tool start (localized)
  logInfo(TOOL, msg('tool.start.valuechain', { tool: TOOL }));
  const t0 = Date.now();

  logDebug(TOOL, `Parameters: strategy="${strategy}", outputDir="${outputDir}", lang=${lang}`);

  // Step 1: Decompose value chain via LLM
  logDebug(TOOL, msg('step.decomposition'));

  const llmCall = createLLMCall({ model: 'claude-sonnet-4-6', effort: 'high' });
  const rawResponse = await llmCall(DECOMPOSE_PROMPT, { description });

  // Parse JSON — strip markdown fences if present
  const jsonStr = rawResponse.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  let chain;
  try {
    chain = JSON.parse(jsonStr);
  } catch (err) {
    logError(TOOL, msg('error.generic', { tool: TOOL, error: `Failed to parse LLM response: ${err.message}` }));
    throw new Error(`Failed to parse LLM value chain response: ${err.message}\nRaw: ${rawResponse.slice(0, 500)}`);
  }

  // Validate chain structure
  if (!chain.title || !chain.anchor || !chain.components?.length) {
    logError(TOOL, msg('error.generic', { tool: TOOL, error: 'LLM returned invalid value chain structure' }));
    throw new Error('LLM returned invalid value chain structure');
  }

  logDebug(TOOL, `Decomposition complete: "${chain.title}" — ${chain.components.length} components + 1 anchor`);

  // Step 2: Evaluate evolution for each component + anchor
  const evaluations = {};
  const allItems = [
    { name: chain.anchor.name, context: chain.anchor.context },
    ...chain.components.map(c => ({ name: c.name, context: c.context })),
  ];

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];

    // Debug: per-component progress
    logDebug(TOOL, msg('step.evaluation.progress', {
      current: i + 1,
      total: allItems.length,
      component: item.name,
    }));

    try {
      const result = await estimateEvolutionOneShot({
        name: item.name,
        description: item.context || description,
        strategy,
      });

      if (result.evaluations) {
        // Pick the requested strategy's result, or first successful one
        const stratResult = result.evaluations[strategy]
          || Object.values(result.evaluations).find(e => !e.error);
        if (stratResult && !stratResult.error) {
          evaluations[item.name] = Math.max(0, Math.min(1, stratResult.evolution));
          logDebug(TOOL, msg('step.evaluation.bestpick', {
            component: item.name,
            evolution: evaluations[item.name],
            strategy: strategy,
            confidence: stratResult.confidence ?? 'N/A',
          }));
        }
      }
    } catch (err) {
      // Log but skip failed evaluations — will use default 0.5
      logDebug(TOOL, msg('step.evaluation.skipped', {
        component: item.name,
        reason: err.message || 'evaluation failed',
      }));
    }
  }

  logDebug(TOOL, msg('step.evaluation.summary', {
    evaluated: Object.keys(evaluations).length,
    skipped: allItems.length - Object.keys(evaluations).length,
    total: allItems.length,
  }));

  // Step 3: Generate .wm content
  logDebug(TOOL, msg('step.wm.generation', { count: chain.components.length }));
  const wmContent = generateWmContent(chain, evaluations);

  // Step 4: Write file
  const finalFilename = filename || slugify(chain.title);
  const filePath = join(outputDir, `${finalFilename}.wm`);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, wmContent, 'utf-8');

  // Info-level: tool end (localized)
  const duration = Date.now() - t0;
  logInfo(TOOL, msg('tool.end.valuechain', { tool: TOOL, count: chain.components.length, duration }));

  return {
    wmContent,
    filePath,
    components: chain.components,
    evaluations,
  };
}

// ─── MCP Tool Definition ────────────────────────────────────────────────────

export const GENERATE_VALUE_CHAIN_TOOL = {
  name: 'generateValueChain',
  description:
    'Generate a Wardley Map .wm file from a business description. ' +
    'Decomposes the business into a value chain, evaluates component evolution, ' +
    'and produces a valid .wm file for the VSCode Online Wardley Maps extension.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Business description or user need to map',
      },
      filename: {
        type: 'string',
        description: 'Output filename without extension (auto-generated if omitted)',
      },
      outputDir: {
        type: 'string',
        description: 'Output directory (default: maps/myMaps)',
        default: 'maps/myMaps',
      },
      strategy: {
        type: 'string',
        description: 'Evolution evaluation strategy (default: timeline-benchmark)',
        default: 'timeline-benchmark',
      },
    },
    required: ['description'],
    additionalProperties: false,
  },
};

/**
 * MCP tool handler for generateValueChain.
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} Result with wmContent, filePath, evaluations
 */
export async function handleGenerateValueChain(args) {
  return generateValueChain(args.description, {
    filename: args.filename,
    outputDir: args.outputDir,
    strategy: args.strategy,
  });
}

// ─── Self-test ──────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== generateValueChain self-test ===\n');

  try {
    const result = await generateValueChain('A tea shop serving hot beverages to customers', {
      outputDir: 'maps/myMaps',
    });
    console.log('--- Generated .wm ---');
    console.log(result.wmContent);
    console.log(`\n--- File written to: ${result.filePath} ---`);
    console.log(`--- Components: ${result.components.length} ---`);
    console.log(`--- Evaluations: ${Object.keys(result.evaluations).length} ---`);
    for (const [name, evo] of Object.entries(result.evaluations)) {
      console.log(`  ${name}: ${evo}`);
    }
  } catch (err) {
    console.error('Self-test failed:', err.message);
  }
}
