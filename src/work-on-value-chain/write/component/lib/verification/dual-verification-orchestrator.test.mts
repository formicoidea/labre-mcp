// Tests for dual-verification-orchestrator.mjs
//
// Validates the dual-verification pipeline:
//   - Tier 1 (naming convention) short-circuit behavior
//   - Tier 2 (LLM) fallback and reconciliation
//   - Tier 3 (web search) evidence and combination
//   - Edge cases (empty, null, error handling)
//   - Routing target computation
//   - VerifiedClassificationResult contract
//
// All tests use mocks â€” no real LLM or web search calls are made.

// Register prompt parsers before any test runs (needed because
// verifyClassification reaches the web-search-verification path which parses
// prompt responses even in mock mode).
import '../../../../../lib/prompts/init.mjs';

import {
  verifyClassification,
  classifyNamingOnly,
  THRESHOLDS,
  COMPONENT_TYPE,
  CONFIDENCE_THRESHOLD,
} from './dual-verification-orchestrator.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

console.log('=== dual-verification-orchestrator test suite ===\n');

// â”€â”€â”€ Contract validation helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function validateResultContract(result, label) {
  assert(typeof result.classification === 'string', `${label}: classification is string`);
  assert(
    result.classification === 'solution' || result.classification === 'capability',
    `${label}: classification is 'solution' or 'capability'`
  );
  assert(typeof result.confidence === 'number', `${label}: confidence is number`);
  assert(result.confidence >= 0 && result.confidence <= 1, `${label}: confidence in [0, 1]`);
  assert(typeof result.method === 'string', `${label}: method is string`);
  assert(typeof result.reasoning === 'string', `${label}: reasoning is string`);
  assert(typeof result.isSolution === 'boolean', `${label}: isSolution is boolean`);
  assert(result.isSolution === (result.classification === 'solution'), `${label}: isSolution consistent`);
  assert(typeof result.verified === 'boolean', `${label}: verified is boolean`);
  assert(Array.isArray(result.tiersUsed), `${label}: tiersUsed is array`);
  assert(result.routingDetection != null, `${label}: routingDetection present`);
  assert(result.routingTargets != null, `${label}: routingTargets present`);
  assert(typeof result.routingTargets.useSolutionStrategies === 'boolean', `${label}: routingTargets.useSolutionStrategies is boolean`);
  assert(typeof result.routingTargets.useCapabilityStrategies === 'boolean', `${label}: routingTargets.useCapabilityStrategies is boolean`);
}

// â”€â”€â”€ Test group 1: Known solutions (Tier 1 only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('--- Group 1: Known solutions (Tier 1 short-circuit) ---');
{
  const solutions = ['Kubernetes', 'Salesforce', 'Docker', 'PostgreSQL', 'AWS', 'Terraform', 'Snowflake', 'Stripe'];

  for (const name of solutions) {
    const r = await verifyClassification(name);
    validateResultContract(r, name);
    assert(r.classification === 'solution', `${name}: is solution`);
    assert(r.confidence >= 0.90, `${name}: confidence >= 0.90 (got ${r.confidence})`);
    assert(r.verified === true, `${name}: verified`);
    assert(r.tiersUsed.length === 1, `${name}: only 1 tier`);
    assert(r.tiersUsed[0] === 'naming', `${name}: naming tier`);
    assert(r.routingTargets.useSolutionStrategies === true, `${name}: routes to solution strategies`);
    assert(r.namingResult != null, `${name}: has namingResult`);
    assert(r.llmResult === undefined, `${name}: no llmResult`);
    assert(r.webSearchResult === undefined, `${name}: no webSearchResult`);
  }
  console.log(`  ${solutions.length} known solutions tested`);
}

// â”€â”€â”€ Test group 2: Known capabilities (Tier 1 only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n--- Group 2: Known capabilities (Tier 1 short-circuit) ---');
{
  const capabilities = ['CRM', 'ERP', 'container orchestration', 'identity management', 'DevOps', 'CI/CD', 'LLM'];

  for (const name of capabilities) {
    const r = await verifyClassification(name);
    validateResultContract(r, name);
    assert(r.classification === 'capability', `${name}: is capability`);
    assert(r.confidence >= 0.90, `${name}: confidence >= 0.90 (got ${r.confidence})`);
    assert(r.verified === true, `${name}: verified`);
    assert(r.isSolution === false, `${name}: isSolution false`);
    assert(r.routingTargets.useCapabilityStrategies === true, `${name}: routes to capability strategies`);
  }
  console.log(`  ${capabilities.length} known capabilities tested`);
}

// â”€â”€â”€ Test group 3: LLM fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n--- Group 3: LLM fallback behavior ---');
{
  // Mock LLM that classifies everything as solution with 0.82 confidence
  const solutionLLM = async () => 'classification=SOLUTION\nconfidence=0.82\nreasoning=Appears to be a branded product';

  // Mock LLM that classifies everything as capability with 0.85 confidence
  const capabilityLLM = async () => 'classification=CAPABILITY\nconfidence=0.85\nreasoning=Appears to be an abstract concept';

  // Test: ambiguous name triggers LLM fallback
  const r1 = await verifyClassification('BrandNewThing', { llmCall: solutionLLM, skipWebSearch: true });
  validateResultContract(r1, 'BrandNewThing');
  assert(r1.tiersUsed.includes('llm'), 'BrandNewThing: LLM tier used');
  assert(r1.llmResult != null, 'BrandNewThing: has llmResult');
  assert(r1.method.includes('llm'), 'BrandNewThing: method includes llm');

  // Test: LLM error is handled gracefully (falls back to naming)
  const failingLLM = async () => { throw new Error('LLM network timeout'); };
  const r2 = await verifyClassification('SomeProduct', { llmCall: failingLLM, skipWebSearch: true });
  validateResultContract(r2, 'SomeProduct+failingLLM');
  assert(r2.tiersUsed.includes('llm'), 'SomeProduct: LLM tier was attempted');
  assert(r2.llmResult?.error != null, 'SomeProduct: llmResult has error');
  // Should still have a valid classification from naming
  assert(r2.classification != null, 'SomeProduct: has classification from naming fallback');

  // Test: skipLLM flag prevents LLM call
  const neverCallLLM = async () => { throw new Error('Should not be called'); };
  const r3 = await verifyClassification('AmbiguousThing', { llmCall: neverCallLLM, skipLLM: true });
  assert(!r3.tiersUsed.includes('llm'), 'AmbiguousThing: LLM skipped with flag');

  console.log('  LLM fallback tests passed');
}

// â”€â”€â”€ Test group 4: Agreement/disagreement reconciliation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n--- Group 4: Tier reconciliation ---');
{
  // Agreement: naming=solution (heuristic, ~0.55) + LLM=solution (0.78) â†’ boosted
  const agreeLLM = async () => 'classification=SOLUTION\nconfidence=0.78\nreasoning=Looks like a product';
  const r1 = await verifyClassification('CloudFormation', { llmCall: agreeLLM, skipWebSearch: true });
  // CloudFormation matches PascalCase compound pattern â†’ solution ~0.55
  // LLM also says solution â†’ agreement bonus
  assert(r1.classification === 'solution', 'CloudFormation: agreement â†’ solution');
  assert(r1.confidence > 0.55, `CloudFormation: agreement boosted confidence (got ${r1.confidence})`);

  // Disagreement: naming=solution (heuristic, ~0.55) + LLM=capability (0.88) â†’ LLM wins with penalty
  const disagreeLLM = async () => 'classification=CAPABILITY\nconfidence=0.88\nreasoning=This is actually a general concept';
  const r2 = await verifyClassification('CloudFormation', { llmCall: disagreeLLM, skipWebSearch: true });
  // Higher confidence tier (LLM at 0.88) should win
  assert(r2.classification === 'capability', `CloudFormation disagree: LLM wins (got ${r2.classification})`);
  // But with disagreement penalty
  assert(r2.confidence < 0.88, `CloudFormation disagree: confidence penalized (got ${r2.confidence})`);
  assert(r2.confidence >= 0.45, `CloudFormation disagree: confidence above floor (got ${r2.confidence})`);

  console.log('  Reconciliation tests passed');
}

// â”€â”€â”€ Test group 5: Web search tier â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n--- Group 5: Web search tier ---');
{
  const uncertainLLM = async () => 'classification=SOLUTION\nconfidence=0.55\nreasoning=Unsure';
  const solutionWebSearch = async () =>
    'classification=SOLUTION\nconfidence=0.92\nreasoning=Found official website and documentation\n' +
    'EVIDENCE_START\ntype=product-page|description=Official website|source=example.com|supports=solution\nEVIDENCE_END\n' +
    'REFERENCES_START\ntitle=Product|url=https://example.com|snippet=A product\nREFERENCES_END';

  const r1 = await verifyClassification('ObscurePlatform', {
    llmCall: uncertainLLM,
    webSearchCall: solutionWebSearch,
  });
  validateResultContract(r1, 'ObscurePlatform+web');
  assert(r1.tiersUsed.includes('web-search'), 'ObscurePlatform: web search tier used');
  assert(r1.webSearchResult != null, 'ObscurePlatform: has webSearchResult');
  assert(r1.classification === 'solution', `ObscurePlatform: web search confirms solution (got ${r1.classification})`);
  assert(r1.confidence > 0.70, `ObscurePlatform: reasonable confidence (got ${r1.confidence})`);

  // Web search error is handled gracefully
  const failingWebSearch = async () => { throw new Error('Network error'); };
  const r2 = await verifyClassification('AnotherProduct', {
    llmCall: uncertainLLM,
    webSearchCall: failingWebSearch,
  });
  validateResultContract(r2, 'AnotherProduct+failingWeb');
  assert(r2.classification != null, 'AnotherProduct: still has classification despite web error');

  console.log('  Web search tier tests passed');
}

// â”€â”€â”€ Test group 6: Edge cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n--- Group 6: Edge cases ---');
{
  const r1 = await verifyClassification('');
  validateResultContract(r1, 'empty');
  assert(r1.classification === 'capability', 'Empty â†’ capability');
  assert(r1.confidence === 0, 'Empty â†’ 0 confidence');
  assert(r1.verified === false, 'Empty â†’ not verified');

  const r2 = await verifyClassification(null);
  validateResultContract(r2, 'null');
  assert(r2.classification === 'capability', 'Null â†’ capability');
  assert(r2.verified === false, 'Null â†’ not verified');

  const r3 = await verifyClassification(undefined);
  validateResultContract(r3, 'undefined');
  assert(r3.classification === 'capability', 'Undefined â†’ capability');

  const r4 = await verifyClassification('   ');
  validateResultContract(r4, 'whitespace');
  assert(r4.classification === 'capability', 'Whitespace â†’ capability');
  assert(r4.confidence === 0, 'Whitespace â†’ 0 confidence');

  console.log('  Edge cases passed');
}

// â”€â”€â”€ Test group 7: classifyNamingOnly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n--- Group 7: classifyNamingOnly convenience ---');
{
  const r1 = classifyNamingOnly('Kubernetes', 'Container orchestration platform');
  validateResultContract(r1, 'classifyNamingOnly-Kubernetes');
  assert(r1.classification === 'solution', 'Kubernetes â†’ solution');
  assert(r1.verified === true, 'Known solution â†’ verified');
  assert(r1.tiersUsed.length === 1, 'Only naming tier');

  const r2 = classifyNamingOnly('CRM');
  assert(r2.classification === 'capability', 'CRM â†’ capability');
  assert(r2.verified === true, 'Known capability â†’ verified');

  const r3 = classifyNamingOnly('');
  assert(r3.confidence === 0, 'Empty â†’ 0 confidence');
  assert(r3.verified === false, 'Empty â†’ not verified');

  console.log('  classifyNamingOnly tests passed');
}

// â”€â”€â”€ Test group 8: Constants exported correctly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n--- Group 8: Constants and exports ---');
{
  assert(THRESHOLDS.NAMING_SKIP === 0.90, 'NAMING_SKIP threshold is 0.90');
  assert(THRESHOLDS.LLM_SKIP === 0.85, 'LLM_SKIP threshold is 0.85');
  assert(THRESHOLDS.MIN_VERIFIED === 0.70, 'MIN_VERIFIED threshold is 0.70');
  assert(COMPONENT_TYPE.SOLUTION === 'solution', 'COMPONENT_TYPE.SOLUTION');
  assert(COMPONENT_TYPE.CAPABILITY === 'capability', 'COMPONENT_TYPE.CAPABILITY');
  assert(CONFIDENCE_THRESHOLD === 0.90, 'CONFIDENCE_THRESHOLD re-exported');

  console.log('  Constants validated');
}

// â”€â”€â”€ Test group 9: Routing targets correctness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log('\n--- Group 9: Routing targets ---');
{
  // Solution â†’ route to solution strategies (exclusive mode default)
  const r1 = await verifyClassification('Kubernetes');
  assert(r1.routingTargets.useSolutionStrategies === true, 'Kubernetes â†’ solution strategies');
  assert(r1.routingTargets.useCapabilityStrategies === false, 'Kubernetes â†’ no capability strategies (exclusive)');

  // Capability â†’ route to capability strategies
  const r2 = await verifyClassification('CRM');
  assert(r2.routingTargets.useSolutionStrategies === false, 'CRM â†’ no solution strategies (exclusive)');
  assert(r2.routingTargets.useCapabilityStrategies === true, 'CRM â†’ capability strategies');

  // Parallel mode: both routes
  const origMode = process.env.WARDLEY_EVAL_MODE;
  process.env.WARDLEY_EVAL_MODE = 'parallel';
  const r3 = await verifyClassification('Kubernetes');
  assert(r3.routingTargets.useSolutionStrategies === true, 'Kubernetes parallel â†’ solution');
  assert(r3.routingTargets.useCapabilityStrategies === true, 'Kubernetes parallel â†’ capability');
  process.env.WARDLEY_EVAL_MODE = origMode;

  console.log('  Routing targets tests passed');
}

// â”€â”€â”€ Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
