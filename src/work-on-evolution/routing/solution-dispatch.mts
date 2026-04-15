// Solution Strategy Dispatch & Routing
//
// Extracted from solution-capability-router.mjs for single-responsibility.
//
// Contains:
//   - EVAL_MODES constant
//   - getEvalMode() — reads routing mode from env
//   - determineRoutingTargets() — exclusive vs parallel routing decision
//   - createSolutionStrategyInstance() — DI wrapper for solution strategies
//   - dispatchSolutionStrategies() — run all/specific solution strategies
//   - dispatchWithRouting() — full routing + dispatch pipeline

import { loadSolutionStrategies } from '../strategies/solution/registry.mjs';
import { assembleSolutionResult } from '../strategies/solution/assemble-result.mjs';
import { logDebug } from '../../lib/mcp-notifications.mjs';
import {
  COMPONENT_TYPE,
  detectComponentType,
} from '../../lib/component-detection.mjs';
import { toErrorMessage, errorCode } from '../../lib/errors.mjs';

/** Routing modes */
export const EVAL_MODES = {
  EXCLUSIVE: 'exclusive',
  PARALLEL: 'parallel',
};

// ─── Routing Mode ─────────────────────────────────────────────────────────────

/**
 * Get the current evaluation mode from environment variable.
 *
 * @returns {string} 'exclusive' or 'parallel'
 */
export function getEvalMode() {
  const mode = (process.env.WARDLEY_EVAL_MODE || 'exclusive').toLowerCase().trim();
  if (mode === 'parallel') return EVAL_MODES.PARALLEL;
  return EVAL_MODES.EXCLUSIVE;
}

/**
 * Determine routing targets based on component detection and eval mode.
 *
 * Enforces the core routing rule:
 *   NAMED → solution-strategies (12 Wardley property evaluation)
 *   GENERIC → capability strategies (6 capability strategies including CPC)
 *
 * In exclusive mode (default):
 *   - solution detected → route to solution-strategies ONLY
 *   - capability detected → route to capability strategies ONLY
 *
 * In parallel mode:
 *   - always route to BOTH strategy sets
 *
 * @param {ComponentTypeDetection} detection - Result from detectComponentType()
 *   or from the dual-verification orchestrator (routingDetection field)
 * @returns {{ useSolutionStrategies: boolean, useCapabilityStrategies: boolean, mode: string }}
 */
export function determineRoutingTargets(detection) {
  const mode = getEvalMode();

  if (mode === EVAL_MODES.PARALLEL) {
    return {
      useSolutionStrategies: true,
      useCapabilityStrategies: true,
      mode: EVAL_MODES.PARALLEL,
    };
  }

  // Exclusive mode (default)
  if (detection.type === COMPONENT_TYPE.SOLUTION) {
    return {
      useSolutionStrategies: true,
      useCapabilityStrategies: false,
      mode: EVAL_MODES.EXCLUSIVE,
    };
  }

  return {
    useSolutionStrategies: false,
    useCapabilityStrategies: true,
    mode: EVAL_MODES.EXCLUSIVE,
  };
}

// ─── Solution Strategy Dispatch ──────────────────────────────────────────────
//
// The dispatch layer sits between the routing decision and the strategy
// execution. When the router determines a component is a solution, these
// functions instantiate and run solution strategies from the solution-strategies
// registry. Results conform to the same EvolutionResult contract used by
// capability strategies, so consumers treat both uniformly.

/**
 * Create a solution strategy instance with LLM dependencies injected.
 *
 * Solution strategies (like properties-strategy) require an llmCall.
 * This mirrors createStrategyInstance() in estimate-evolution.mjs.
 *
 * @param {typeof import('../strategies/solution/solution-base-strategy.mjs').SolutionBaseStrategy} StrategyCls
 * @param {Object} deps
 * @param {function} [deps.llmCall] - LLM call function
 * @param {string}   [deps.mode]   - 'auto' or 'conversational'
 * @returns {import('../strategies/solution/solution-base-strategy.mjs').SolutionBaseStrategy}
 */
export function createSolutionStrategyInstance(StrategyCls: any, deps: any = {}) {
  // All solution strategies currently use LLM for evaluation
  if (deps.llmCall) {
    return new StrategyCls({
      llmCall: deps.llmCall,
      ...(deps.mode && { mode: deps.mode }),
    });
  }

  // Try default constructor as fallback (may throw if llmCall required)
  return new StrategyCls();
}

/**
 * Run all (or a specific) solution strategies on a component.
 *
 * This is the solution-side equivalent of the capability strategy loop
 * in estimateEvolutionOneShot().
 *
 * @param {Object} component - Component to evaluate (tagged as solution)
 * @param {Object} options
 * @param {function} options.llmCall - LLM call function
 * @param {string}   [options.strategy='all'] - Specific strategy method or 'all'
 * @param {string}   [options.mode='auto']    - 'auto' or 'conversational'
 * @returns {Promise<Object<string, import('../strategies/solution/solution-base-strategy.mjs').SolutionEvolutionResult>>}
 */
export async function dispatchSolutionStrategies(component: any, options: any = {}): Promise<any> {
  const { llmCall, strategy = 'all', mode = 'auto' } = options;
  const evaluations: Record<string, any> = {};

  // Tag the component for solution strategies
  const solutionComponent = { ...component, isSolution: true };

  if (strategy === 'all') {
    const strategies = await loadSolutionStrategies();
    const strategyNames = [...strategies.keys()];

    logDebug('solution-dispatch',
      `Running ${strategyNames.length} solution strategy(ies) for "${component.name}": ${strategyNames.join(', ')}`);

    for (const [method, StrategyCls] of strategies) {
      try {
        logDebug('solution-dispatch', `Running solution strategy "${method}" on "${component.name}"...`);
        const instance = createSolutionStrategyInstance(StrategyCls, { llmCall, mode });
        const rawResult = await Promise.resolve(instance.evaluate(solutionComponent));
        // Enrich with structured metadata (phase distribution, stage, confidence metadata)
        evaluations[method] = assembleSolutionResult(rawResult, { mode });
        logDebug('solution-dispatch',
          `Solution "${method}": evolution=${rawResult.evolution}, confidence=${rawResult.confidence}`);
      } catch (err) {
        evaluations[method] = { error: toErrorMessage(err) };
        logDebug('solution-dispatch', `Solution "${method}" failed: ${toErrorMessage(err)}`);
      }
    }
  } else {
    // Run specific solution strategy
    try {
      const { getSolutionStrategy } = await import('../strategies/solution/registry.mjs');
      const StrategyCls = await getSolutionStrategy(strategy);
      logDebug('solution-dispatch', `Running solution strategy "${strategy}" on "${component.name}"...`);
      const instance = createSolutionStrategyInstance(StrategyCls, { llmCall, mode });
      const rawResult = await Promise.resolve(instance.evaluate(solutionComponent));
      // Enrich with structured metadata
      evaluations[strategy] = assembleSolutionResult(rawResult, { mode });
      logDebug('solution-dispatch',
        `Solution "${strategy}": evolution=${rawResult.evolution}, confidence=${rawResult.confidence}`);
    } catch (err) {
      evaluations[strategy] = { error: toErrorMessage(err) };
      logDebug('solution-dispatch', `Solution "${strategy}" failed: ${toErrorMessage(err)}`);
    }
  }

  return evaluations;
}

/**
 * @typedef {Object} RoutedEvaluationResult
 * @property {Object}  evaluations           - Merged evaluations from all dispatched strategies
 * @property {Object}  [solutionEvaluations] - Solution-only evaluations (present when solution strategies ran)
 * @property {Object}  [capabilityEvaluations] - Capability-only evaluations (present when capability strategies ran)
 * @property {ComponentTypeDetection} detection - The detection result
 * @property {{ useSolutionStrategies: boolean, useCapabilityStrategies: boolean, mode: string }} targets - Routing targets
 */

/**
 * Full routing + dispatch pipeline.
 *
 * Detects component type, determines routing targets, dispatches to the
 * appropriate strategy set(s), and returns merged evaluations.
 *
 * For capability strategies, the caller provides a callback that runs
 * the existing capability evaluation pipeline. For solution strategies,
 * this function dispatches directly.
 *
 * @param {Object} component - Component with at least { name }
 * @param {Object} options
 * @param {function} [options.llmCall]  - LLM call function (for detection fallback + solution strategies)
 * @param {function} [options.runCapabilityStrategies] - Callback: (component, strategy) => Promise<evaluations>
 * @param {string}   [options.strategy='all']  - Strategy name or 'all'
 * @param {string}   [options.mode='auto']     - 'auto' or 'conversational'
 * @param {string}   [options.description]     - Component description for detection
 * @returns {Promise<RoutedEvaluationResult>}
 */
export async function dispatchWithRouting(component: any, options: any = {}): Promise<any> {
  const {
    llmCall,
    runCapabilityStrategies: capabilityCallback,
    strategy = 'all',
    mode = 'auto',
    description = '',
  } = options;

  // Step 1: Detect component type
  const detection = detectComponentType(component.name, description || component.description || '');

  // Step 2: Determine routing targets
  const targets = determineRoutingTargets(detection);

  logDebug('solution-dispatch',
    `Routing "${component.name}": type=${detection.type}, confidence=${detection.confidence}, ` +
    `mode=${targets.mode} -> solution=${targets.useSolutionStrategies}, capability=${targets.useCapabilityStrategies}`);

  let capabilityEvaluations = {};
  let solutionEvaluations = {};

  // Step 3a: Run capability strategies if routed
  if (targets.useCapabilityStrategies && typeof capabilityCallback === 'function') {
    capabilityEvaluations = await capabilityCallback(component, strategy);
  }

  // Step 3b: Run solution strategies if routed
  if (targets.useSolutionStrategies) {
    solutionEvaluations = await dispatchSolutionStrategies(component, {
      llmCall,
      strategy: strategy === 'all' ? 'all' : strategy,
      mode,
    });
  }

  // Step 4: Merge evaluations (solution results get a 'solution:' prefix to avoid key collisions)
  const evaluations = { ...capabilityEvaluations };
  for (const [method, result] of Object.entries(solutionEvaluations)) {
    // Only prefix if there would be a key collision
    const key = evaluations[method] ? `solution:${method}` : method;
    evaluations[key] = result;
  }

  return {
    evaluations,
    solutionEvaluations,
    capabilityEvaluations,
    detection,
    targets,
  };
}
