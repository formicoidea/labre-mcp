// Tests for publication-analysis-strategy parsing robustness.
//
// Regression: multilingual prose (e.g. French) preceding the final
// `key=value` block could cause the prior lenient regex to capture a
// bare "." (from sentence punctuation), producing NaN that silently
// traversed pubEvolution and only surfaced at validateResult.
//
// Run directly: node src/strategies/publication-analysis-strategy.test.mjs

import assert from 'node:assert/strict';
import { PublicationAnalysisStrategy, parsePubResponse } from './publication-analysis-strategy.mjs';

// --- parsePubResponse ---

// 1. Standard English response — unchanged behavior
{
  const text = `Some reasoning here.
wonder=0.10
build=0.30
operate=0.40
usage=0.20`;
  const r = parsePubResponse(text);
  assert.deepEqual(r, { wonder: 0.10, build: 0.30, operate: 0.40, usage: 0.20 });
  console.log('ok — standard English response parses');
}

// 2. French prose ending with sentences mentioning the keywords,
//    then the mandatory block. Previously: NaN from "." capture.
{
  const text = `Analyse : peu de publications de type wonder.
Les guides build sont nombreux. En operate. Et en usage.
wonder=0.05
build=0.40
operate=0.35
usage=0.20`;
  const r = parsePubResponse(text);
  assert.deepEqual(r, { wonder: 0.05, build: 0.40, operate: 0.35, usage: 0.20 });
  console.log('ok — French prose + final block parses correctly');
}

// 3. Colon form tolerated
{
  const text = `wonder: 0.1
build: 0.2
operate: 0.3
usage: 0.4`;
  const r = parsePubResponse(text);
  assert.deepEqual(r, { wonder: 0.1, build: 0.2, operate: 0.3, usage: 0.4 });
  console.log('ok — colon form tolerated');
}

// 4. Missing key → explicit error (not NaN)
{
  const text = `wonder=0.1
build=0.2
operate=0.3`;
  assert.throws(() => parsePubResponse(text), /could not parse response/);
  console.log('ok — missing key throws parse error');
}

// 5. Bare "." value → explicit error (not NaN). The new strict regex
//    rejects this at the match stage, so it is reported as a parse miss.
{
  const text = `wonder=.
build=0.2
operate=0.3
usage=0.4`;
  assert.throws(() => parsePubResponse(text), /could not parse response/);
  console.log('ok — bare "." value rejected');
}

// 6. Negative value → rejected at regex stage (strict line format excludes sign)
{
  const text = `wonder=-0.1
build=0.2
operate=0.3
usage=0.4`;
  assert.throws(() => parsePubResponse(text), /could not parse response/);
  console.log('ok — negative value rejected by strict line format');
}

// --- evaluate() end-to-end with injected llmCall ---

// 7. Injected LLM returns a French-prose response → evolution is a finite number
{
  const llmCall = async () => `Raisonnement en français sur wonder. et build.
Conclusion :
wonder=0.10
build=0.25
operate=0.40
usage=0.25`;
  const strategy = new PublicationAnalysisStrategy({ llmCall });
  const result = await strategy.evaluate({ name: 'Test', context: 'ctx' });
  assert.equal(result.method, 'publication-analysis');
  assert.ok(Number.isFinite(result.evolution), 'evolution must be finite');
  assert.ok(result.evolution >= 0 && result.evolution <= 1, 'evolution in [0,1]');
  assert.ok(Number.isFinite(result.confidence));
  console.log('ok — evaluate() with French prose returns finite evolution');
}

console.log('\nAll publication-analysis parsing tests passed.');
