// Eval Mode Dispatcher: routes component evaluation to the correct strategy set(s)
// based on WARDLEY_EVAL_MODE environment variable.
//
// This module is the integration layer between the solution-capability router
// (which DETECTS component type) and the strategy registries (which EVALUATE).
//
// Routing modes (controlled by WARDLEY_EVAL_MODE env var):
//   - "exclusive" (default): routes to ONE strategy set based on detection
//       * solution detected  -> solution-strategies/ only
//       * capability detected -> strategies/ only
//   - "parallel": routes to BOTH strategy sets regardless of detection
//       * results are merged under namespaced keys (solution:* and capability:*)
//
// This module does NOT modify any existing strategy files.
// It sits between the orchestrator and the registries, providing a unified
// dispatch interface.
//
// Usage:
//   import { dispatchEvaluation, getEffectiveEvalMode } from './eval-mode-dispatcher.mjs';
//
//   const result = await dispatchEvaluation(component, detection, {
//     createCapabilityInstance,
//     createSolutionInstance,
//   });

import {
  detectComponentType,
  COMPONENT_TYPE,
} from '../../lib/component-detection.mjs';
import {
  determineRoutingTargets,
  getEvalMode,
  EVAL_MODES,
} from './solution-dispatch.mjs';
import { loadStrategies } from '../strategies/capacity/registry.mjs';
import type { ComponentTypeDetection } from '../../types/routing.mjs';
import { loadSolutionStrategies } from '../strategies/solution/registry.mjs';
import { logDebug } from '../../lib/mcp-notifications.mjs';
import { toErrorMessage, errorCode } from '../../lib/errors.mjs';

const TOOL = 'evalModeDispatcher';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DispatchOptions
 * @property {function} [createCapabilityInstance] - Factory to create capability strategy instances (with LLM injection)
 * @property {function} [createSolutionInstance]   - Factory to create solution strategy instances (with LLM injection)
 * @property {string}   [strategy]                 - Specific strategy to run (default: 'all')
 * @property {boolean}  [skipPhaseB]               - Skip Phase B enrichment (for testing)
 */

/**
 * @typedef {Object} DispatchResult
 * @property {Object<string, import('../strategies/capacity/base-strategy.mjs').EvolutionResult>} evaluations
 *   - Keyed by strategy method name. In parallel mode, solution strategy keys are
 *     prefixed with "solution:" (e.g. "solution:solution-properties")
 * @property {import('./solution-capability-router.mjs').ComponentTypeDetection} detection
 * @property {string}  evalMode    - 'exclusive' or 'parallel'
 * @property {boolean} usedSolutionStrategies  - Whether solution strategies were executed
 * @property {boolean} usedCapabilityStrategies - Whether capability strategies were executed
 * @property {Object}  [enrichedComponent]      - Component with Phase B enrichments (if applicable)
 */

// ─── Strategy Execution Helpers ──────────────────────────────────────────────

/**
 * Run all capability strategies on a component.
 * Follows the existing Phase A/B/C pipeline pattern from estimate-evolution.mjs.
 *
 * @param {Object} component - Component input
 * @param {function} createInstance - Factory for capability strategy instances
 * @returns {Promise<Object<string, import('../strategies/capacity/base-strategy.mjs').EvolutionResult>>}
 */
// any: createInstance is a strategy-class factory closure with diverse callbacks
// any: component is a ComponentInput superset; response shape varies
async function runCapabilityStrategies(component: any, createInstance: (cls: any) => any): Promise<any> {
  const strategies = await loadStrategies();
  const evaluations: Record<string, any> = {};

  // Phase A: Run all non-s-curve strategies first
  for (const [method, StrategyCls] of strategies) {
    if (method === 's-curve') continue;
    try {
      logDebug(TOOL, `Running capability strategy "${method}" on "${component.name}"...`);
      const instance = createInstance(StrategyCls);
      const result = await Promise.resolve(instance.evaluate(component));
      evaluations[method] = result;
      logDebug(TOOL, `Capability strategy "${method}": evolution=${result.evolution}, confidence=${result.confidence}`);
    } catch (err) {
      evaluations[method] = { error: (err as Error).message };
      logDebug(TOOL, `Capability strategy "${method}" failed: ${(err as Error).message}`);
    }
  }

  // Phase B: Enrich component with certitude/ubiquity from LLM results
  // any: ComponentInput + derived LLM averages (certitude, ubiquity)
  const enrichedComponent: any = { ...component };
  if (enrichedComponent.certitude == null || enrichedComponent.ubiquity == null) {
    const llmResults = // any: evaluations values are heterogeneous strategy results
(Object.values(evaluations) as any[]).filter(
      e => !e.error && e.certitude != null && e.ubiquity != null
    );
    if (llmResults.length > 0) {
      enrichedComponent.certitude = Math.round(
        llmResults.reduce((s: number, r: { certitude: number }) => s + r.certitude, 0) / llmResults.length * 1000
      ) / 1000;
      enrichedComponent.ubiquity = Math.round(
        llmResults.reduce((s: number, r: { ubiquity: number }) => s + r.ubiquity, 0) / llmResults.length * 1000
      ) / 1000;
      logDebug(TOOL, `Enriched "${component.name}": certitude=${enrichedComponent.certitude}, ubiquity=${enrichedComponent.ubiquity}`);
    }
  }

  // Phase C: Run s-curve with enriched component
  const scurveCls = strategies.get('s-curve');
  if (scurveCls) {
    try {
      logDebug(TOOL, `Running capability strategy "s-curve" on "${component.name}"...`);
      const instance = createInstance(scurveCls);
      const result = await Promise.resolve(instance.evaluate(enrichedComponent));
      evaluations['s-curve'] = result;
      logDebug(TOOL, `Capability strategy "s-curve": evolution=${result.evolution}, confidence=${result.confidence}`);
    } catch (err) {
      evaluations['s-curve'] = { error: toErrorMessage(err) };
      logDebug(TOOL, `Capability strategy "s-curve" failed: ${toErrorMessage(err)}`);
    }
  }

  return evaluations;
}

/**
 * Run all solution strategies on a component.
 *
 * @param {Object} component - Component input (with isSolution flag)
 * @param {function} createInstance - Factory for solution strategy instances
 * @returns {Promise<Object<string, import('../strategies/capacity/base-strategy.mjs').EvolutionResult>>}
 */
// any: component is a SolutionInput superset; createInstance is a DI closure
async function runSolutionStrategies(component: any, createInstance: (cls: any) => any): Promise<Record<string, any>> {
  const strategies = await loadSolutionStrategies();
  const evaluations: Record<string, any> = {};

  for (const [method, StrategyCls] of strategies) {
    try {
      logDebug(TOOL, `Running solution strategy "${method}" on "${component.name}"...`);
      const instance = createInstance(StrategyCls);
      const result = await Promise.resolve(instance.evaluate(component));
      evaluations[method] = result;
      logDebug(TOOL, `Solution strategy "${method}": evolution=${result.evolution}, confidence=${result.confidence}`);
    } catch (err) {
      evaluations[method] = { error: (err as Error).message };
      logDebug(TOOL, `Solution strategy "${method}" failed: ${(err as Error).message}`);
    }
  }

  return evaluations;
}

// ─── Namespace Helpers ───────────────────────────────────────────────────────

/**
 * Prefix strategy keys for parallel mode to avoid collisions.
 * In parallel mode, solution strategy keys get "solution:" prefix
 * and capability strategy keys get "capability:" prefix.
 *
 * @param {Object} evaluations - Strategy results
 * @param {string} namespace   - 'solution' or 'capability'
 * @returns {Object} Namespaced evaluations
 */
function namespaceResults(evaluations: Record<string, unknown>, namespace: string): Record<string, unknown> {
  const namespaced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evaluations)) {
    namespaced[`${namespace}:${key}`] = value;
  }
  return namespaced;
}

// ─── Main Dispatch Function ──────────────────────────────────────────────────

/**
 * Dispatch component evaluation to the correct strategy set(s) based on
 * detection result and WARDLEY_EVAL_MODE.
 *
 * In exclusive mode (default):
 *   - solution detected -> runs solution-strategies/ only
 *   - capability detected -> runs strategies/ only
 *   - Strategy keys are NOT namespaced (backward compatible)
 *
 * In parallel mode:
 *   - Always runs BOTH strategy sets
 *   - Solution strategy keys are prefixed "solution:"
 *   - Capability strategy keys are prefixed "capability:"
 *
 * @param {Object} component - Component input (name, description, etc.)
 * @param {import('./solution-capability-router.mjs').ComponentTypeDetection} detection
 *   - Result from detectComponentType(). If null, detection is performed internally.
 * @param {DispatchOptions} [options={}]
 * @returns {Promise<DispatchResult>}
 */
// any: options bag includes createInstance, createSolutionInstance, strategy, etc.; response shape varies
export async function dispatchEvaluation(component: any, detection: ComponentTypeDetection | null = null, options: any = {}): Promise<any> {
  const {
    createCapabilityInstance = defaultInstanceFactory,
    createSolutionInstance = defaultInstanceFactory,
    strategy = 'all',
  } = options;

  // Step 1: Detect component type if not provided.
  // `description` is the label we classify on (not `context`, which is the
  // business environment and can be noisy for detection).
  const effectiveDetection = detection || detectComponentType(
    component.name,
    component.description ?? '',
  );

  // Step 2: Determine routing targets
  const targets = determineRoutingTargets(effectiveDetection);
  const evalMode = targets.mode;

  logDebug(TOOL, `Dispatching "${component.name}": type=${effectiveDetection.type}, mode=${evalMode}, ` +
    `solution=${targets.useSolutionStrategies}, capability=${targets.useCapabilityStrategies}`);

  // Step 3: Prepare solution-enriched component
  // any: effectiveDetection has loose extension fields (canonical, vendor, category) typed as unknown
  const det = effectiveDetection as any;
  const solutionComponent = {
    ...component,
    isSolution: det.type === COMPONENT_TYPE.SOLUTION,
    routerConfidence: det.confidence,
    ...(det.canonical ? { canonicalName: det.canonical } : {}),
    ...(det.vendor ? { vendor: det.vendor } : {}),
    ...(det.category ? { solutionCategory: det.category } : {}),
  };

  // Step 4: Execute strategy set(s)
  let evaluations = {};

  if (evalMode === EVAL_MODES.PARALLEL) {
    // Parallel mode: run both sets concurrently, namespace the keys
    const [solutionEvals, capabilityEvals] = await Promise.all([
      targets.useSolutionStrategies
        ? runSolutionStrategies(solutionComponent, createSolutionInstance)
        : Promise.resolve({}),
      targets.useCapabilityStrategies
        ? runCapabilityStrategies(component, createCapabilityInstance)
        : Promise.resolve({}),
    ]);

    // Namespace results to avoid key collisions
    evaluations = {
      ...namespaceResults(solutionEvals, 'solution'),
      ...namespaceResults(capabilityEvals, 'capability'),
    };

    logDebug(TOOL, `Parallel mode: ${Object.keys(solutionEvals).length} solution + ` +
      `${Object.keys(capabilityEvals).length} capability strategies executed`);
  } else {
    // Exclusive mode: run only the target set, no namespacing
    if (targets.useSolutionStrategies) {
      evaluations = await runSolutionStrategies(solutionComponent, createSolutionInstance);
      logDebug(TOOL, `Exclusive mode (solution): ${Object.keys(evaluations).length} strategies executed`);
    } else if (targets.useCapabilityStrategies) {
      evaluations = await runCapabilityStrategies(component, createCapabilityInstance);
      logDebug(TOOL, `Exclusive mode (capability): ${Object.keys(evaluations).length} strategies executed`);
    }
  }

  return {
    evaluations,
    detection: effectiveDetection,
    evalMode,
    usedSolutionStrategies: targets.useSolutionStrategies,
    usedCapabilityStrategies: targets.useCapabilityStrategies,
    enrichedComponent: solutionComponent,
  };
}

// ─── Convenience Functions ──────────────────────────────────────────────────

/**
 * Get the effective eval mode, resolving the env var.
 * Re-exported for consumers that need to check the mode without dispatching.
 *
 * @returns {string} 'exclusive' or 'parallel'
 */
export function getEffectiveEvalMode() {
  return getEvalMode();
}

/**
 * Check if the dispatcher will run in parallel mode.
 * Convenience for conditional logic in orchestrators.
 *
 * @returns {boolean} true if WARDLEY_EVAL_MODE=parallel
 */
export function isParallelMode() {
  return getEvalMode() === EVAL_MODES.PARALLEL;
}

/**
 * Build a summary of what the dispatcher would do for a given component,
 * without actually running any strategies. Useful for dry-run/preview.
 *
 * @param {string} name - Component name
 * @param {string} [description] - Description
 * @returns {{ detection: Object, targets: Object, evalMode: string }}
 */
export function previewDispatch(name: string, description: string = '') {
  const detection = detectComponentType(name, description);
  const targets = determineRoutingTargets(detection);
  return {
    detection,
    targets,
    evalMode: targets.mode,
  };
}

// ─── Default Instance Factory ───────────────────────────────────────────────

/**
 * Default strategy instance factory (no LLM injection).
 * Used when the caller doesn't provide custom factories.
 *
 * @param {function} StrategyCls - Strategy class constructor
 * @returns {Object} Strategy instance
 */
function defaultInstanceFactory(StrategyCls: new () => unknown): unknown {
  return new StrategyCls();
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export { EVAL_MODES, COMPONENT_TYPE };
