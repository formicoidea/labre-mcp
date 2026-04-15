// Pluggability test: proves a new solution strategy can be added by
// creating a single file implementing the SolutionBaseStrategy interface,
// with zero modifications to existing code.
//
// Test flow:
//   1. Load initial solution strategies, count them
//   2. Write a new strategy file to disk
//   3. Clear cache, reload — verify the new strategy is discovered
//   4. Instantiate and evaluate — verify result shape and contract
//   5. Verify aggregation utilities work correctly
//   6. Clean up the temporary strategy file
//
// Mirrors src/strategies/pluggability.test.mjs for capability strategies.

import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import {
  loadSolutionStrategies,
  clearSolutionCache,
  getSolutionStrategy,
  listSolutionStrategies,
} from './registry.mjs';
import { SolutionBaseStrategy, PHASE_TO_EVOLUTION, PHASE_LABELS } from './solution-base-strategy.mjs';
import { BaseStrategy } from '../capacity/base-strategy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMP_STRATEGY_FILE = join(__dirname, 'example-test-strategy.mjs');

const TEMP_STRATEGY_CODE = `
import { SolutionBaseStrategy } from './solution-base-strategy.mjs';

export class ExampleTestStrategy extends SolutionBaseStrategy {
  static get method() {
    return 'example-test';
  }

  async evaluate(component) {
    // Trivial implementation for pluggability proof
    const properties = [
      SolutionBaseStrategy.buildPropertyEvaluation('Market', 3, 'Well-known product'),
      SolutionBaseStrategy.buildPropertyEvaluation('Knowledge', 2, 'Requires expertise'),
      SolutionBaseStrategy.buildPropertyEvaluation('Perception', 3, 'Understood'),
    ];

    const { evolution, confidence } = SolutionBaseStrategy.aggregateProperties(properties);

    return SolutionBaseStrategy.validateSolutionResult({
      evolution,
      confidence,
      method: ExampleTestStrategy.method,
      properties,
    });
  }
}
`;

async function test() {
  console.log('=== Solution Strategy Pluggability Test ===\n');

  // Step 1: Load existing solution strategies
  clearSolutionCache();
  const before = await loadSolutionStrategies();
  const countBefore = before.size;
  console.log(`[1] Solution strategies before: ${countBefore} — [${[...before.keys()].join(', ') || '(none)'}]`);
  assert.ok(!before.has('example-test'), 'example-test should NOT exist yet');

  // Step 2: Write a new strategy file (simulating "developer creates one file")
  await writeFile(TEMP_STRATEGY_FILE, TEMP_STRATEGY_CODE, 'utf-8');
  console.log('[2] Wrote example-test-strategy.mjs');

  // Step 3: Clear cache and reload — new strategy should be auto-discovered
  clearSolutionCache();
  const after = await loadSolutionStrategies();
  const countAfter = after.size;
  console.log(`[3] Solution strategies after: ${countAfter} — [${[...after.keys()].join(', ')}]`);
  assert.equal(countAfter, countBefore + 1, 'Should have exactly one more strategy');
  assert.ok(after.has('example-test'), 'example-test should be discovered');

  // Step 4: Verify the strategy works and returns correct shape
  const TestCls = await getSolutionStrategy('example-test');
  assert.equal(TestCls.method, 'example-test');
  const instance = new TestCls();
  assert.ok(instance instanceof SolutionBaseStrategy, 'Must extend SolutionBaseStrategy');
  assert.ok(instance instanceof BaseStrategy, 'Must also be instanceof BaseStrategy (contract compatibility)');

  const result = await instance.evaluate({ name: 'Test Solution' });
  assert.equal(typeof result.evolution, 'number');
  assert.equal(typeof result.confidence, 'number');
  assert.equal(typeof result.method, 'string');
  assert.equal(result.method, 'example-test');
  assert.ok(result.evolution >= 0 && result.evolution <= 1, 'Evolution must be in [0,1]');
  assert.ok(result.confidence >= 0 && result.confidence <= 1, 'Confidence must be in [0,1]');
  console.log(`[4] evaluate() returned: ${JSON.stringify(result)}`);

  // Validate via both validators (contract compatibility)
  BaseStrategy.validateResult(result); // should not throw
  SolutionBaseStrategy.validateSolutionResult(result); // should not throw
  console.log('[4] Result passes both BaseStrategy.validateResult() and SolutionBaseStrategy.validateSolutionResult()');

  // Step 5: Verify properties array
  assert.ok(Array.isArray(result.properties), 'Result should have properties array');
  assert.equal(result.properties.length, 3, 'Should have 3 property evaluations');
  for (const prop of result.properties) {
    assert.ok(typeof prop.property === 'string', 'Property name must be a string');
    assert.ok(prop.phase >= 1 && prop.phase <= 4, `Phase must be 1–4, got ${prop.phase}`);
    assert.ok(typeof prop.label === 'string', 'Phase label must be a string');
    assert.ok(typeof prop.weight === 'number', 'Weight must be a number');
  }
  console.log('[5] Properties validated: all have property, phase, label, weight');

  // Step 6: listSolutionStrategies includes the new one
  const list = await listSolutionStrategies();
  assert.ok(list.includes('example-test'), 'listSolutionStrategies() should include new strategy');
  console.log(`[6] listSolutionStrategies() = [${list.join(', ')}]`);

  // Step 7: Verify utility functions
  assert.equal(SolutionBaseStrategy.phaseToEvolution(1), 0.09, 'Phase 1 → 0.09');
  assert.equal(SolutionBaseStrategy.phaseToEvolution(2), 0.29, 'Phase 2 → 0.29');
  assert.equal(SolutionBaseStrategy.phaseToEvolution(3), 0.55, 'Phase 3 → 0.55');
  assert.equal(SolutionBaseStrategy.phaseToEvolution(4), 0.85, 'Phase 4 → 0.85');
  assert.equal(SolutionBaseStrategy.phaseLabel(1), 'Genesis');
  assert.equal(SolutionBaseStrategy.phaseLabel(2), 'Custom');
  assert.equal(SolutionBaseStrategy.phaseLabel(3), 'Product');
  assert.equal(SolutionBaseStrategy.phaseLabel(4), 'Commodity');
  console.log('[7] Phase utilities verified: phaseToEvolution() and phaseLabel()');

  // Step 8: Verify aggregation with 12 equal-weight properties
  const fullProperties = Array.from({ length: 12 }, (_, i) =>
    SolutionBaseStrategy.buildPropertyEvaluation(`Prop${i + 1}`, 3)
  );
  const fullAgg = SolutionBaseStrategy.aggregateProperties(fullProperties);
  assert.equal(fullAgg.evolution, 0.55, '12 properties all at phase 3 → evolution = 0.55');
  assert.equal(fullAgg.confidence, 0.85, 'Full coverage → confidence = 0.85');
  console.log(`[8] Aggregation with 12 properties (all phase 3): evolution=${fullAgg.evolution}, confidence=${fullAgg.confidence}`);

  // Step 9: Verify PHASE constants are exported
  assert.equal(PHASE_TO_EVOLUTION[1], 0.09);
  assert.equal(PHASE_LABELS[4], 'Commodity');
  console.log('[9] Exported constants PHASE_TO_EVOLUTION and PHASE_LABELS verified');

  // Cleanup
  await unlink(TEMP_STRATEGY_FILE);
  clearSolutionCache();
  console.log('[10] Cleaned up temporary strategy file');

  // Verify removal
  clearSolutionCache();
  const final = await loadSolutionStrategies();
  assert.ok(!final.has('example-test'), 'example-test should be gone after cleanup');
  console.log(`[11] After cleanup: ${final.size} strategies — [${[...final.keys()].join(', ') || '(none)'}]`);

  console.log('\n\u2713 Solution strategy pluggability test PASSED — new strategy added and removed with zero code changes\n');
}

test().catch(err => {
  // Cleanup on failure
  unlink(TEMP_STRATEGY_FILE).catch(() => {});
  console.error('\n\u2717 Solution strategy pluggability test FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
