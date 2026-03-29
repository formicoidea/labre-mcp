// Pluggability test: proves a 7th strategy can be added by creating
// a single file implementing the interface, with zero modifications
// to existing code.
//
// Test flow:
//   1. Load initial strategies, count them
//   2. Write a new strategy file to disk
//   3. Clear cache, reload — verify the new strategy is discovered
//   4. Instantiate and evaluate — verify EvolutionResult shape
//   5. Clean up the temporary strategy file

import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { loadStrategies, clearCache, getStrategy, listStrategies } from './registry.mjs';
import { BaseStrategy } from './base-strategy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMP_STRATEGY_FILE = join(__dirname, 'example-seventh-strategy.mjs');

const TEMP_STRATEGY_CODE = `
import { BaseStrategy } from './base-strategy.mjs';

export class ExampleSeventhStrategy extends BaseStrategy {
  static get method() {
    return 'example-seventh';
  }

  evaluate(component) {
    // Trivial implementation for pluggability proof
    const evolution = 0.5;
    const confidence = 0.6;
    return BaseStrategy.validateResult({
      evolution,
      confidence,
      method: ExampleSeventhStrategy.method,
    });
  }
}
`;

async function test() {
  console.log('=== Pluggability Test: Adding a 7th Strategy ===\n');

  // Step 1: Load existing strategies
  clearCache();
  const before = await loadStrategies();
  const countBefore = before.size;
  console.log(`[1] Strategies before: ${countBefore} — [${[...before.keys()].join(', ')}]`);
  assert.ok(countBefore >= 2, 'Should have at least 2 strategies initially');
  assert.ok(!before.has('example-seventh'), 'example-seventh should NOT exist yet');

  // Step 2: Write a new strategy file (simulating "developer creates one file")
  await writeFile(TEMP_STRATEGY_FILE, TEMP_STRATEGY_CODE, 'utf-8');
  console.log('[2] Wrote example-seventh-strategy.mjs');

  // Step 3: Clear cache and reload — new strategy should be auto-discovered
  clearCache();
  const after = await loadStrategies();
  const countAfter = after.size;
  console.log(`[3] Strategies after: ${countAfter} — [${[...after.keys()].join(', ')}]`);
  assert.equal(countAfter, countBefore + 1, 'Should have exactly one more strategy');
  assert.ok(after.has('example-seventh'), 'example-seventh should be discovered');

  // Step 4: Verify the strategy works and returns correct shape
  const SeventhCls = await getStrategy('example-seventh');
  assert.equal(SeventhCls.method, 'example-seventh');
  const instance = new SeventhCls();
  assert.ok(instance instanceof BaseStrategy, 'Must extend BaseStrategy');

  const result = instance.evaluate({ name: 'Test Component' });
  assert.equal(typeof result.evolution, 'number');
  assert.equal(typeof result.confidence, 'number');
  assert.equal(typeof result.method, 'string');
  assert.equal(result.method, 'example-seventh');
  console.log(`[4] evaluate() returned: ${JSON.stringify(result)}`);

  // Validate via base class validator
  BaseStrategy.validateResult(result); // should not throw
  console.log('[4] Result passes BaseStrategy.validateResult()');

  // Step 5: listStrategies includes the new one
  const list = await listStrategies();
  assert.ok(list.includes('example-seventh'), 'listStrategies() should include new strategy');
  console.log(`[5] listStrategies() = [${list.join(', ')}]`);

  // Cleanup
  await unlink(TEMP_STRATEGY_FILE);
  clearCache();
  console.log('[6] Cleaned up temporary strategy file');

  // Verify removal
  clearCache();
  const final = await loadStrategies();
  assert.ok(!final.has('example-seventh'), 'example-seventh should be gone after cleanup');
  console.log(`[7] After cleanup: ${final.size} strategies — [${[...final.keys()].join(', ')}]`);

  console.log('\n✓ Pluggability test PASSED — 7th strategy added and removed with zero code changes\n');
}

test().catch(err => {
  // Cleanup on failure
  unlink(TEMP_STRATEGY_FILE).catch(() => {});
  console.error('\n✗ Pluggability test FAILED:', err.message);
  process.exit(1);
});
