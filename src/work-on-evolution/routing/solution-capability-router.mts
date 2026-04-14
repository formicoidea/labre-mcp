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

// ─── Self-test ────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== solution-capability-router self-test ===\n');

  const testCases = [
    // Known solutions — should detect with high confidence
    { name: 'Kubernetes', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'k8s', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Salesforce', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'SAP ERP', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Docker', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'PostgreSQL', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'AWS', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Terraform', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Snowflake', expectedType: 'solution', expectedMinConf: 0.95 },
    { name: 'Stripe', expectedType: 'solution', expectedMinConf: 0.95 },

    // Known capabilities — should detect as capability
    { name: 'CRM', expectedType: 'capability', expectedMinConf: 0.95 },
    { name: 'ERP', expectedType: 'capability', expectedMinConf: 0.95 },
    { name: 'container orchestration', expectedType: 'capability', expectedMinConf: 0.85 },
    { name: 'identity management', expectedType: 'capability', expectedMinConf: 0.85 },
    { name: 'DevOps', expectedType: 'capability', expectedMinConf: 0.95 },
    { name: 'CI/CD', expectedType: 'capability', expectedMinConf: 0.95 },
    { name: 'LLM', expectedType: 'capability', expectedMinConf: 0.95 },

    // Heuristic detection — solution patterns
    { name: 'Google BigQuery', expectedType: 'solution', expectedMinConf: 0.50 },
    { name: 'React 18', expectedType: 'solution', expectedMinConf: 0.50 },
    { name: 'CloudFormation', expectedType: 'solution', expectedMinConf: 0.50 },

    // Heuristic detection — capability patterns
    { name: 'Manage customer relationships', expectedType: 'capability', expectedMinConf: 0.50 },
    { name: 'how to manage IT services', expectedType: 'capability', expectedMinConf: 0.50 },
    { name: 'payment processing', expectedType: 'capability', expectedMinConf: 0.50 },
    { name: 'data analytics', expectedType: 'capability', expectedMinConf: 0.50 },

    // Edge cases
    { name: 'Electricity', expectedType: 'capability', expectedMinConf: 0.30 },
    { name: 'Wardley Mapping', expectedType: 'capability', expectedMinConf: 0.30 },
  ];

  let passed = 0;
  for (const tc of testCases) {
    const result = detectComponentType(tc.name);
    const typeOk = result.type === tc.expectedType;
    const confOk = result.confidence >= tc.expectedMinConf;
    const ok = typeOk && confOk;
    const mark = ok ? '✓' : '✗';

    console.log(`  ${mark} "${tc.name}"`);
    console.log(`    Type: ${result.type} (expected: ${tc.expectedType}) ${typeOk ? '✓' : '✗'}`);
    console.log(`    Confidence: ${result.confidence.toFixed(2)} (min: ${tc.expectedMinConf}) ${confOk ? '✓' : '✗'}`);
    console.log(`    Method: ${result.method}`);
    console.log(`    Reason: ${result.reason}`);
    console.log(`    Needs fallback: ${result.needsFallback}`);
    console.log();

    if (ok) passed++;
  }

  console.log(`\n--- Routing tests ---\n`);

  // Test routing targets
  const kubeDetection = detectComponentType('Kubernetes');
  const crmDetection = detectComponentType('CRM');

  // Test exclusive mode (default)
  const kubeTargets = determineRoutingTargets(kubeDetection);
  console.log(`  Kubernetes (exclusive): solution=${kubeTargets.useSolutionStrategies}, capability=${kubeTargets.useCapabilityStrategies}`);
  console.assert(kubeTargets.useSolutionStrategies === true, 'Kubernetes should use solution strategies');
  console.assert(kubeTargets.useCapabilityStrategies === false, 'Kubernetes should not use capability strategies in exclusive');

  const crmTargets = determineRoutingTargets(crmDetection);
  console.log(`  CRM (exclusive): solution=${crmTargets.useSolutionStrategies}, capability=${crmTargets.useCapabilityStrategies}`);
  console.assert(crmTargets.useSolutionStrategies === false, 'CRM should not use solution strategies');
  console.assert(crmTargets.useCapabilityStrategies === true, 'CRM should use capability strategies');

  // Test parallel mode
  const origMode = process.env.WARDLEY_EVAL_MODE;
  process.env.WARDLEY_EVAL_MODE = 'parallel';
  const kubeParallel = determineRoutingTargets(kubeDetection);
  console.log(`  Kubernetes (parallel): solution=${kubeParallel.useSolutionStrategies}, capability=${kubeParallel.useCapabilityStrategies}`);
  console.assert(kubeParallel.useSolutionStrategies === true, 'Parallel should use solution');
  console.assert(kubeParallel.useCapabilityStrategies === true, 'Parallel should use capability');
  process.env.WARDLEY_EVAL_MODE = origMode;

  // Test confidence threshold
  console.log(`\n--- Confidence threshold tests ---\n`);
  console.log(`  CONFIDENCE_THRESHOLD: ${CONFIDENCE_THRESHOLD}`);
  console.log(`  Known solution (Kubernetes): needsFallback=${kubeDetection.needsFallback} (confidence=${kubeDetection.confidence})`);
  console.log(`  Known capability (CRM): needsFallback=${crmDetection.needsFallback} (confidence=${crmDetection.confidence})`);

  const unknownDetection = detectComponentType('XyzFooWidget');
  console.log(`  Unknown (XyzFooWidget): needsFallback=${unknownDetection.needsFallback} (confidence=${unknownDetection.confidence})`);
  console.assert(unknownDetection.needsFallback === true, 'Unknown component should need fallback');

  console.log(`\n${passed}/${testCases.length} classification tests passed`);
  console.log('\n=== solution-capability-router self-test completed ===');
}
