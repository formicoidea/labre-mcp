// Input validation and classification resolution for one-shot evolution estimation
//
// Extracted from estimate-evolution.mjs — single responsibility:
//   - validateOneShotInput: validates and normalizes raw input parameters
//   - resolveClassification: resolves classification via pre-set space or classification gate
//   - VALID_SPACES: canonical list of valid Wardley spaces

import { classifyComponent } from '../routing/classification-gate.mjs';

// ─── Valid Spaces ────────────────────────────────────────────────────────────

export const VALID_SPACES = ['economic', 'social_good', 'common_good'];

// ─── Input Validation ────────────────────────────────────────────────────────

/**
 * @typedef {Object} OneShotInput
 * @property {string}  name         - Component name (required)
 * @property {string}  [description] - Business/usage context (recommended)
 * @property {string}  [space]      - Pre-classification: 'economic' | 'social_good' | 'common_good'
 * @property {string}  [strategy]   - Strategy name or 'all' (default: 'all')
 * @property {number}  [certitude]  - How well-understood (0-1)
 * @property {number}  [ubiquity]   - How widespread (0-1)
 * @property {number}  [wonder]     - Publication proportion: novelty (0-1)
 * @property {number}  [build]      - Publication proportion: building (0-1)
 * @property {number}  [operate]    - Publication proportion: operations (0-1)
 * @property {number}  [usage]      - Publication proportion: commodity usage (0-1)
 */

/**
 * Validate one-shot input parameters.
 * Throws descriptive errors for invalid inputs.
 *
 * @param {*} input - Raw input
 * @returns {OneShotInput} Validated and normalized input
 */
export function validateOneShotInput(input: any): any {
  if (input == null || typeof input !== 'object') {
    throw new Error('Input must be a non-null object');
  }

  const {
    name, description, space, strategy, pipeline,
    certitude, ubiquity, wonder, build, operate, usage,
  } = input;

  // Required: name
  if (name == null || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Required parameter "name" must be a non-empty string');
  }

  // Optional strings
  if (description != null && typeof description !== 'string') {
    throw new Error('Parameter "description" must be a string');
  }
  if (strategy != null && typeof strategy !== 'string') {
    throw new Error('Parameter "strategy" must be a string');
  }

  // Space validation
  if (space != null) {
    if (typeof space !== 'string') {
      throw new Error('Parameter "space" must be a string');
    }
    const normalizedSpace = space.trim().toLowerCase();
    if (!VALID_SPACES.includes(normalizedSpace)) {
      throw new Error(
        `Parameter "space" must be one of: ${VALID_SPACES.join(', ')}. Got: "${space}"`
      );
    }
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
    description: (description || '').trim(),
    space: space ? space.trim().toLowerCase() : undefined,
    strategy: (strategy || 'all').trim(),
    ...(certitude != null && { certitude }),
    ...(ubiquity != null && { ubiquity }),
    ...(wonder != null && { wonder }),
    ...(build != null && { build }),
    ...(operate != null && { operate }),
    ...(usage != null && { usage }),
    ...(pipeline != null && { pipeline: Boolean(pipeline) }),
  };
}

// ─── Classification Resolution ──────────────────────────────────────────────

/**
 * Resolve classification: use provided space or auto-detect via classification gate.
 *
 * @param {string} name - Component name
 * @param {string} description - Context/description
 * @param {string|undefined} space - Pre-classified space or undefined
 * @returns {import('../routing/classification-gate.mjs').ClassificationResult}
 */
export function resolveClassification(name: string, description: string, space: string | undefined): any {
  if (space) {
    // Use the provided space directly — skip the classification gate
    const requiresReQuestion = space !== 'economic';
    const reasons: Record<string, string> = {
      economic: `"${name}" pre-classified as economic — suitable for Wardley evolution evaluation.`,
      social_good: `"${name}" pre-classified as social_good — naturally available resource outside economic space.`,
      common_good: `"${name}" pre-classified as common_good — collectively managed resource beyond economic space.`,
    };

    return {
      space,
      reason: reasons[space],
      requiresReQuestion,
    };
  }

  // Auto-detect via classification gate
  return classifyComponent(name, description);
}
