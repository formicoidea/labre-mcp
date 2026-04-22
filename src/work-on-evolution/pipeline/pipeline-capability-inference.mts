// Pipeline capability inference — deduces the underlying capability from a solution name.
//
// When the pipeline enrichment mode (pipeline: true) receives a solution input
// (e.g. "Kubernetes", "Scrum", "ISO 27001"), this module uses the Tier 2 LLM
// (via the existing identifyCapability function) to determine the generic
// capability that the solution addresses.
//
// The result is a structured intermediate object used by the pipeline orchestrator
// to run the 3-evaluation sequence:
//   1. Capability pivot (the inferred capability)
//   2. Solution SotA (state-of-the-art solution in the same capability space)
//   3. Solution legacy (an older/less-evolved solution)
//
// This module does NOT add latency to the default routing path — it is only
// invoked when pipeline: true is explicitly requested.
//
// Usage:
//   import { inferCapabilityFromSolution } from './pipeline-capability-inference.mjs';
//
//   const result = await inferCapabilityFromSolution('Kubernetes', {
//     description: 'Container orchestration platform',
//     llmCall,
//   });
//   // → {
//   //   solutionName: 'Kubernetes',
//   //   capability: 'Orchestrate containers',
//   //   capabilityLabel: 'Container Orchestration',
//   //   nature: 'activity',
//   //   wardleyType: 'component',
//   //   confidence: 0.92,
//   //   justification: '...',
//   // }

import { identifyCapability, parseCapabilityResponse } from '../../work-on-value-chain/write/component/identify-capability.mjs';
import { logDebug } from '../../lib/mcp-notifications.mjs';
import { toErrorMessage, errorCode } from '../../lib/errors.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL = 'pipelineCapabilityInference';

// ─── Result Type ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PipelineCapabilityInferenceResult
 * @property {string}  solutionName    - Original solution name input
 * @property {string}  capability      - Inferred capability (nature-formatted, e.g. "Orchestrate containers")
 * @property {string}  capabilityLabel - Clean label for OWM display (e.g. "Container Orchestration")
 * @property {string}  nature          - Wardley component nature: activity | practice | knowledge | data
 * @property {string}  wardleyType     - Component type: component | pipeline | anchor | market | ecosystem
 * @property {number}  confidence      - Confidence in the inference (0–1)
 * @property {string}  justification   - LLM reasoning for the inference
 * @property {boolean} inferred        - Always true — marks this as an LLM inference result
 */

// ─── Capability Label Normalization ──────────────────────────────────────────

/**
 * Convert a nature-formatted capability string into a clean display label
 * suitable for OWM component names.
 *
 * Transformations by nature:
 *   - activity: "Orchestrate containers" → "Container Orchestration"
 *     (removes leading verb, nominalizes)
 *   - practice: "how to manage IT services" → "IT Service Management"
 *     (removes "how to", nominalizes)
 *   - knowledge: "technical expertise in welding" → "Welding Expertise"
 *   - data: kept as-is with title case
 *
 * Falls back to title-casing the raw capability if transformation fails.
 *
 * @param {string} capability - Nature-formatted capability string
 * @param {string} nature     - Component nature (activity/practice/knowledge/data)
 * @returns {string} Clean label for OWM display
 */
export function capabilityToLabel(capability: string, nature?: string): string {
  if (!capability) return 'Capability';

  const trimmed = capability.trim();

  try {
    switch (nature) {
      case 'activity': {
        // "Orchestrate containers" → "Container Orchestration"
        // "Manage customer relationships" → "Customer Relationship Management"
        // Remove leading infinitive verb, nominalize the rest
        const verbMatch = trimmed.match(
          /^(manage|orchestrate|automate|process|handle|deliver|provide|build|create|monitor|analyze|store|compute|deploy|serve|route|transform|integrate|authenticate|authorize|brew|develop|test|maintain|secure|encrypt|optimize|schedule|balance|discover|log|cache|message|stream|search|index|render)\s+(.+)$/i
        );
        if (verbMatch) {
          const verb = verbMatch[1].toLowerCase();
          const object = verbMatch[2].trim();
          // Nominalize: verb → noun form
          const nominalizations = {
            manage: 'Management', orchestrate: 'Orchestration',
            automate: 'Automation', process: 'Processing',
            handle: 'Handling', deliver: 'Delivery',
            provide: 'Provisioning', build: 'Building',
            create: 'Creation', monitor: 'Monitoring',
            analyze: 'Analytics', store: 'Storage',
            compute: 'Computing', deploy: 'Deployment',
            serve: 'Serving', route: 'Routing',
            transform: 'Transformation', integrate: 'Integration',
            authenticate: 'Authentication', authorize: 'Authorization',
            brew: 'Brewing', develop: 'Development',
            test: 'Testing', maintain: 'Maintenance',
            secure: 'Security', encrypt: 'Encryption',
            optimize: 'Optimization', schedule: 'Scheduling',
            balance: 'Balancing', discover: 'Discovery',
            log: 'Logging', cache: 'Caching',
            message: 'Messaging', stream: 'Streaming',
            search: 'Search', index: 'Indexing',
            render: 'Rendering',
          };
          const nounForm = (nominalizations as Record<string, string>)[verb] || (verb.charAt(0).toUpperCase() + verb.slice(1) + 'ing');
          // Title-case the object and append nominalization
          const objectTitled = titleCase(object);
          return `${objectTitled} ${nounForm}`;
        }
        // No verb detected — title case
        return titleCase(trimmed);
      }

      case 'practice': {
        // "how to manage IT services" → "IT Service Management"
        const howToMatch = trimmed.match(/^how\s+to\s+(.+)$/i);
        if (howToMatch) {
          // Recursively process as activity
          return capabilityToLabel(howToMatch[1], 'activity');
        }
        return titleCase(trimmed);
      }

      case 'knowledge': {
        // "technical expertise in welding" → "Welding Expertise"
        // "interpersonal skills for coaching" → "Coaching Skills"
        const expertiseMatch = trimmed.match(/(?:technical\s+)?expertise\s+(?:in|for|on)\s+(.+)/i);
        if (expertiseMatch) {
          return `${titleCase(expertiseMatch[1])} Expertise`;
        }
        const skillsMatch = trimmed.match(/(?:interpersonal\s+)?skills\s+(?:in|for|on)\s+(.+)/i);
        if (skillsMatch) {
          return `${titleCase(skillsMatch[1])} Skills`;
        }
        return titleCase(trimmed);
      }

      case 'data':
      default:
        return titleCase(trimmed);
    }
  } catch {
    return titleCase(trimmed);
  }
}

/**
 * Title-case a string: capitalize first letter of each word.
 * @param {string} str
 * @returns {string}
 */
function titleCase(str: string): string {
  // Preserve existing capitalization for abbreviations (IT, CRM, API, etc.)
  return str.replace(/\b\w+/g, (word: string) => {
    // If already all-caps and length >= 2, keep it (likely an abbreviation)
    if (word.length >= 2 && word === word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

// ─── Main Inference Function ─────────────────────────────────────────────────

/**
 * Infer the underlying capability from a solution name using the Tier 2 LLM.
 *
 * This is the core function for pipeline mode's first step: given a named
 * solution (product, framework, methodology, standard), determine the generic
 * capability it addresses.
 *
 * @param {string} solutionName - The solution name (e.g. "Kubernetes", "Scrum", "ISO 27001")
 * @param {Object} options
 * @param {string}   [options.description] - Additional context about the solution
 * @param {function} options.llmCall       - LLM call function (from llm-call.mjs)
 * @returns {Promise<PipelineCapabilityInferenceResult>}
 */
// any: options bag (description, llmCall, ...) — result is { capability, nature, confidence, reasoning }
export async function inferCapabilityFromSolution(solutionName: string, options: any = {}): Promise<any> {
  const { description = '', llmCall } = options;

  if (!solutionName || typeof solutionName !== 'string') {
    throw new Error('inferCapabilityFromSolution: solutionName must be a non-empty string');
  }
  if (typeof llmCall !== 'function') {
    throw new Error('inferCapabilityFromSolution: llmCall function is required');
  }

  const trimmedName = solutionName.trim();

  logDebug(TOOL, `Inferring capability for solution "${trimmedName}"...`);

  // Delegate to the existing identifyCapability module
  // It already has the full LLM prompt and parsing logic
  const component = {
    name: trimmedName,
    description: description || '',
    context: description || '',
  };

  const capResult = await identifyCapability(component, llmCall);

  logDebug(TOOL, `Inferred capability for "${trimmedName}": ` +
    `"${capResult.capability}" (nature=${capResult.nature}, confidence=${capResult.confidence})`);

  // Build the clean label for OWM display
  const capabilityLabel = capabilityToLabel(capResult.capability, capResult.nature);

  logDebug(TOOL, `Capability label for "${trimmedName}": "${capabilityLabel}"`);

  return {
    solutionName: trimmedName,
    capability: capResult.capability,
    capabilityLabel,
    nature: capResult.nature || 'activity',
    wardleyType: capResult.type || 'component',
    confidence: capResult.confidence,
    justification: capResult.justification || '',
    inferred: true,
  };
}
