// Invariant I3 — a run is REPLAYABLE: at fixed LLM outputs, two executions of
// the same recipe with the same injected clock and run-id factory produce a
// STRICTLY identical artefact, byte for byte.
//
// This is the falsifiable form of the invariant. It runs the real path end to
// end — recipe runner + event bus + core artefact-writer listener + the real
// `writeArtifact` onto disk — and compares the two JSON files as raw strings.
// Nothing is mocked except the two things the invariant explicitly holds fixed:
//
//   * the LLM, stubbed at the registry seam (setLLMCallForTesting), because
//     "à sorties LLM fixées" is a premise of I3, not something it asserts;
//   * the clock and the run-id factory, injected through RunClock — the two
//     nondeterministic sources the runner owns.
//
// A negative control runs the same recipe WITHOUT the injected clock and
// asserts the artefacts differ: without it, a test that compares two artefacts
// could pass for reasons that have nothing to do with determinism.
//
// SCOPE NOTE. The injection covers what the RUNNER stamps (run id, event
// timestamps, trace timestamps, durations) plus the artefact's attach-time
// `startedAt`. A strategy that stamps its own `capturedAt` with a real clock
// stays nondeterministic — that is the strategy's own clock, out of the
// runner's reach — so the strategies below stamp a fixed one on purpose.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecipe, runCommand, type RunClock } from './recipe-runner.mjs';
import type { Recipe } from './recipe.schema.mjs';
import { StrategyRegistry } from '../registry/strategy-registry.mjs';
import { BaseStrategy, type StrategyResult } from '../ast/base-strategy.mjs';
import { createEventBus } from '../bus/event-bus.mjs';
import { attachArtifactWriter } from '../listeners/artifact-writer-listener.mjs';
import type { RequestContext } from '../context/request-context.mjs';
import { resetLLMConfigCache } from '#lib/llm/config.loader.mjs';
import { getStrategyLLM, setLLMCallForTesting, resetLLMRegistryCache } from '#lib/llm/registry.mjs';

// ── The stubbed LLM ────────────────────────────────────────────────────

const LLM_STRATEGY_ID = 'publication-analysis';
const CANNED_ANSWER = 'a fixed answer, identical on every run';

/** Minimal valid llm.config.json — the registry loads the config BEFORE it
 *  looks at the test override, so a config file has to exist even though no
 *  provider is ever reached. */
function minimalLlmConfig(): unknown {
  return {
    defaultProvider: 'claude',
    providers: { claude: { kind: 'agent-sdk' } },
    strategies: { [LLM_STRATEGY_ID]: { provider: 'claude', model: 'claude-sonnet-4-6' } },
  };
}

// ── Strategies under test ──────────────────────────────────────────────
//
// Fixed `capturedAt`: a strategy's own timestamps are its own business (see
// the scope note above). Pinning them here isolates what this test is about —
// the runner's stamps — instead of re-testing a strategy's clock discipline.

const FIXED_CAPTURED_AT = '2026-01-01T00:00:00.000Z';

/** Calls the (stubbed) LLM and carries its answer into the envelope. */
class LlmSummaryStrategy extends BaseStrategy<string, string> {
  static get method(): string {
    return 'wardley:chain:write:capacity:llm-summary';
  }
  async evaluate(input: string): Promise<StrategyResult<string>> {
    const call = getStrategyLLM(LLM_STRATEGY_ID);
    const answer = await call(`summarise: ${input}`);
    return {
      signals: [
        { name: 'inputLength', value: input.length, source: 'user-input', capturedAt: FIXED_CAPTURED_AT },
      ],
      reasoning: [{ by: LlmSummaryStrategy.method, text: answer }],
      insights: [],
      result: answer,
    };
  }
}

/** A pure second step, so the recipe exercises the multi-step path. */
class CountStrategy extends BaseStrategy<string, number> {
  static get method(): string {
    return 'wardley:chain:write:capacity:count';
  }
  async evaluate(input: string): Promise<StrategyResult<number>> {
    return {
      signals: [{ name: 'words', value: input.split(' ').length, source: 'computed', capturedAt: FIXED_CAPTURED_AT }],
      reasoning: [],
      insights: [],
      result: input.length,
    };
  }
}

/** One listener — and exactly one. Listeners run in parallel (ARCH-10), so
 *  with two of them the ORDER in which they draw from a stepping clock is not
 *  guaranteed; a single listener keeps the draw sequence deterministic. */
class EchoListener extends BaseStrategy<string, null> {
  static get method(): string {
    return 'wardley:chain:audit:capacity:echo';
  }
  async evaluate(input: string): Promise<StrategyResult<null>> {
    return {
      signals: [],
      reasoning: [],
      insights: [{ text: `observed ${input.length} chars`, by: EchoListener.method, type: 'other' }],
      result: null,
    };
  }
}

const RECIPE: Recipe = {
  schemaVersion: '1.0',
  name: 'summarise-then-count',
  domain: 'wardley',
  tool: 'chain',
  steps: [
    { stepId: 'summarise', tool: LlmSummaryStrategy.method, in: '$.input', out: '$.summary' },
    { stepId: 'count', tool: CountStrategy.method, in: '$.summary.result', out: '$.counted' },
  ],
  listeners: { summarise: [EchoListener.method] },
};

function buildRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();
  registry.register(LlmSummaryStrategy.method, LlmSummaryStrategy);
  registry.register(CountStrategy.method, CountStrategy);
  registry.register(EchoListener.method, EchoListener);
  return registry;
}

// ── The injected clock ─────────────────────────────────────────────────

/**
 * A stepping fake clock: starts at a fixed instant and advances by a fixed
 * amount on every read. Stepping rather than frozen on purpose — it makes the
 * durations non-zero, so an artefact that reproduces is reproducing real
 * numbers, not a run where every subtraction happens to yield 0.
 *
 * A FRESH instance per run, both seeded identically: that is the whole
 * premise — same recipe, same clock, same artefact.
 */
function steppingClock(startIso = '2026-02-02T10:00:00.000Z', stepMs = 500): RunClock {
  let millis = Date.parse(startIso);
  return {
    now: () => {
      const at = new Date(millis);
      millis += stepMs;
      return at;
    },
    newId: () => 'run-0000-fixed',
  };
}

/** The artefact's attach-time `startedAt` — a single instant, not a sequence. */
const writerClock = (): Date => new Date('2026-02-02T09:59:59.000Z');

// ── Harness ────────────────────────────────────────────────────────────

let tmpRoot: string;
let originalConfigEnv: string | undefined;

function buildContext(artifactDir: string): RequestContext {
  return {
    projectId: 'determinism',
    projectRoot: '/tmp/determinism',
    sessionId: 'fixed-session',
    domain: 'wardley',
    artifactDir,
  };
}

/**
 * One full run, artefact included. Each run writes into its OWN directory:
 * with an injected id factory both runs produce the same `<runId>.json` file
 * name, so a shared directory would have the second run overwrite the first
 * and the comparison would be vacuous.
 */
async function runOnce(label: string, clock?: RunClock): Promise<string> {
  const artifactDir = await mkdtemp(join(tmpRoot, `${label}-`));
  const context = buildContext(artifactDir);
  const bus = createEventBus();
  const ast: Record<string, unknown> = { input: 'a value chain of four components' };

  const handle = attachArtifactWriter({
    bus,
    context,
    getAst: () => ast,
    ...(clock === undefined ? {} : { now: writerClock }),
  });

  await runRecipe({ recipe: RECIPE, ast, context, registry: buildRegistry(), bus, clock });

  const path = await handle.artifactPath;
  assert.ok(path !== null, 'the artefact writer must have produced a path');
  await handle.detach();
  return readFile(path as string, 'utf8');
}

describe('recipe runner — replayable runs (invariant I3)', () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'labre-determinism-'));
    originalConfigEnv = process.env.WARDLEY_LLM_CONFIG;
    const configPath = join(tmpRoot, 'llm.config.json');
    await writeFile(configPath, JSON.stringify(minimalLlmConfig()), 'utf8');
    process.env.WARDLEY_LLM_CONFIG = configPath;
    resetLLMConfigCache();
    resetLLMRegistryCache();
    setLLMCallForTesting(LLM_STRATEGY_ID, 'text', async () => CANNED_ANSWER);
  });

  afterEach(async () => {
    if (originalConfigEnv === undefined) delete process.env.WARDLEY_LLM_CONFIG;
    else process.env.WARDLEY_LLM_CONFIG = originalConfigEnv;
    resetLLMConfigCache();
    resetLLMRegistryCache();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('produces a byte-identical artefact on two runs with the same injected clock', async () => {
    const first = await runOnce('run-a', steppingClock());
    const second = await runOnce('run-b', steppingClock());

    // The load-bearing assertion: the two artefact FILES are the same bytes.
    assert.equal(first, second, 'two replayed runs must write the same artefact bytes');
    // Deep equality too, so a failure reports WHICH sub-tree diverged rather
    // than just "the strings differ".
    assert.deepEqual(JSON.parse(first), JSON.parse(second));

    const body = JSON.parse(first) as {
      recipeRunId: string;
      startedAt: string;
      completedAt: string;
      events: Array<{ phase: string; timestamp: string; durationMs?: number }>;
      ast: Record<string, unknown>;
    };
    assert.equal(body.recipeRunId, 'run-0000-fixed', 'the injected id factory owns the run id');
    assert.equal(body.startedAt, '2026-02-02T09:59:59.000Z');
    // 2 steps → step-start/step-end ×2, then run-end: 5 events, all stamped
    // from the injected sequence starting at 10:00:00.000Z.
    assert.deepEqual(
      body.events.map((e) => e.phase),
      ['step-start', 'step-end', 'step-start', 'step-end', 'run-end'],
    );
    assert.equal(body.events[0].timestamp, '2026-02-02T10:00:00.000Z');
    assert.equal(body.events[1].timestamp, '2026-02-02T10:00:00.500Z');
    assert.equal(body.events[1].durationMs, 500, 'durations come from the injected clock too');
    // The stubbed LLM answer really did travel through the artefact — this run
    // is a genuine LLM-bearing run, not a pure one.
    assert.ok(first.includes(CANNED_ANSWER), 'the LLM answer must be in the artefact');
  });

  it('differs on two runs left on the real clock (the control that makes the test bite)', async () => {
    const first = await runOnce('real-a');
    const second = await runOnce('real-b');
    assert.notEqual(first, second, 'without the injected seam, two runs cannot be identical');
  });

  it('reproduces the envelope trace, listener entry included', async () => {
    const registry = buildRegistry();
    const ast: Record<string, unknown> = { input: 'a value chain of four components' };
    const outcome = await runRecipe({
      recipe: RECIPE,
      ast,
      context: buildContext(tmpRoot),
      registry,
      clock: steppingClock(),
    });

    assert.equal(outcome.recipeRunId, 'run-0000-fixed');
    // Two steps then the listener, all stamped from the same sequence.
    assert.deepEqual(
      outcome.envelope.trace.map((t) => [t.stepId, t.startedAt, t.completedAt, t.durationMs]),
      [
        ['summarise', '2026-02-02T10:00:00.000Z', '2026-02-02T10:00:00.500Z', 500],
        ['count', '2026-02-02T10:00:01.000Z', '2026-02-02T10:00:01.500Z', 500],
        ['summarise', '2026-02-02T10:00:02.000Z', '2026-02-02T10:00:02.500Z', 500],
      ],
    );
  });

  it('forwards the injected clock through runCommand', async () => {
    const outcome = await runCommand({
      command: CountStrategy.method,
      input: 'four words right here',
      context: buildContext(tmpRoot),
      registry: buildRegistry(),
      clock: steppingClock(),
    });

    assert.equal(outcome.recipeRunId, 'run-0000-fixed');
    assert.equal(outcome.envelope.trace[0].startedAt, '2026-02-02T10:00:00.000Z');
  });

  it('publishes only the envelope channels it actually fills', async () => {
    const ast: Record<string, unknown> = { input: 'x' };
    const outcome = await runRecipe({
      recipe: RECIPE,
      ast,
      context: buildContext(tmpRoot),
      registry: buildRegistry(),
      clock: steppingClock(),
    });

    // Guard against a field coming back as decoration: every key published here
    // must have a producer. `context` and `references` were removed for lack of
    // one — re-adding either without filling it must fail this test.
    assert.deepEqual(Object.keys(outcome.envelope).sort(), [
      'insights',
      'reasoning',
      'signals',
      'trace',
    ]);
  });
});
