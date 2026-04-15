// Solution vs Capability Router
//
// Core routing rule:
//   NAMED components → SOLUTION path  (products, frameworks, methodologies, standards)
//   GENERIC components → CAPABILITY path (abstract activities, practices, data, knowledge)
//
// "Named" means the component has a specific identity: a brand name, a proper
// noun, a titled framework or methodology, or a recognized standard.
// Examples: Kubernetes, ITIL, Scrum, ISO 27001, TOGAF, Six Sigma, React, SAP ERP
//
// "Generic" means the component describes an abstract capability that could be
// fulfilled by multiple implementations or is not tied to a specific identity.
// Examples: container orchestration, CRM, change management, data storage
//
// Detection strategy (ordered by priority):
//   1. Naming convention heuristics with confidence score (fast, no LLM)
//   2. When confidence < 90%, the caller should use LLM + web search fallback
//      (implemented separately in the routing dispatch layer via
//       dual-verification-orchestrator.mjs)
//
// Routing is exclusive by default (env: WARDLEY_EVAL_MODE=exclusive|parallel):
//   - exclusive: routes to solution-strategies OR capability strategies, not both
//   - parallel: routes to both, returns combined results
//
// The router does NOT modify existing strategy files or the capability pipeline.
// It sits AFTER the classification gate and BEFORE strategy dispatch.

// ─── Detection functions extracted to routing/component-detection.mjs ────────
// Re-exported here for backward compatibility with existing consumers.
export {
  detectComponentType,
  normalizeName,
  isCommonWord,
  matchKnownSolution,
  matchKnownCapability,
  applyHeuristics,
  COMPONENT_TYPE,
  CONFIDENCE_THRESHOLD,
} from '../../lib/component-detection.mjs';

import {
  COMPONENT_TYPE,
  CONFIDENCE_THRESHOLD,
  detectComponentType,
} from '../../lib/component-detection.mjs';

// ─── Dispatch functions extracted to routing/solution-dispatch.mjs ───────────
// Re-exported here for backward compatibility with existing consumers.
export {
  EVAL_MODES,
  getEvalMode,
  determineRoutingTargets,
  createSolutionStrategyInstance,
  dispatchSolutionStrategies,
  dispatchWithRouting,
} from './solution-dispatch.mjs';

import { determineRoutingTargets } from './solution-dispatch.mjs';

// ─── Wardley Type Classification extracted to routing/wardley-type-classification.mjs ─
// Re-exported here for backward compatibility with existing consumers.
export {
  WARDLEY_TYPE,
  WARDLEY_TYPE_PATTERNS,
  classifyWardleyType,
} from './wardley-type-classification.mjs';
