// Regression: a numeric year passed as `component.date` must reach the
// llm-direct prompt as that year — `new Date(1995).getFullYear()` is 1970.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import '#lib/prompts/init.mjs'; // registers the prompt parsers
import { LLMDirectStrategy, resolvePromptYear } from './llm-direct-strategy.mjs';
import { TimelineBenchmarkStrategy } from './timeline-benchmark-strategy.mjs';

const CURRENT_YEAR = new Date().getFullYear();

test('resolvePromptYear: numeric year is a year, other inputs keep the Date path', () => {
  assert.equal(resolvePromptYear(1995), '1995');
  assert.equal(resolvePromptYear(CURRENT_YEAR), String(CURRENT_YEAR));
  assert.equal(resolvePromptYear('1995'), '1995');
  assert.equal(resolvePromptYear('2010-06-15'), '2010');
  assert.equal(resolvePromptYear(new Date('2010-06-15')), '2010');
  assert.equal(resolvePromptYear(Date.UTC(2010, 5, 15)), '2010');
  assert.equal(resolvePromptYear(undefined), 'unknown');
});

test('llm-direct: numeric date 1995 reaches the prompt as 1995', async () => {
  const prompts: string[] = [];
  const llmCall = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve('evolution=0.55\nconfidence=0.75');
  };
  // any: synthetic context — evaluate does not read it
  await new LLMDirectStrategy({ llmCall }).evaluate({ kind: 'capability', name: 'Web hosting', date: 1995 }, {} as any);
  assert.match(prompts[0], /Context date: 1995/);
});

test('timeline-benchmark: milestones are evaluated at their own year, not 1970', async () => {
  const directPrompts: string[] = [];
  let iteration = 0;
  // The marker phrase lives in timeline-benchmark.system.md (system/user split),
  // so branch on the system prompt rather than the user prompt.
  const llmCall = (prompt: string, _schema?: unknown, opts?: { systemPrompt?: string }) => {
    if (opts?.systemPrompt?.includes('NEXT chronological milestone')) {
      const year = iteration++ === 0 ? 1995 : CURRENT_YEAR;
      return Promise.resolve(`milestone_name=Milestone ${year}\nmilestone_date=${year}`);
    }
    // LLM-direct evaluation (one call per milestone)
    directPrompts.push(prompt);
    return Promise.resolve('evolution=0.55\nconfidence=0.75');
  };

  const result = await new TimelineBenchmarkStrategy({ llmCall }).evaluate({
    kind: 'capability',
    name: 'Web hosting',
    capability: 'Provide on-demand compute', // pre-identified — skips phase 1
  });

  assert.deepEqual(result.trace.map((m: { date: number }) => m.date), [1995, CURRENT_YEAR]);
  assert.equal(directPrompts.length, 2);
  assert.match(directPrompts[0], /Context date: 1995/);
  assert.match(directPrompts[1], new RegExp(`Context date: ${CURRENT_YEAR}`));
  assert.ok(directPrompts.every((p) => !p.includes('1970')), 'no prompt should mention 1970');
});
