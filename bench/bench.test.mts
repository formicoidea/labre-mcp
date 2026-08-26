// The bench, exercised end to end WITHOUT A NETWORK.
//
// What this file is for: the CH-27 bench ships DRY — no campaign has been run,
// no token has been spent. The only thing that can be asserted before a human
// authorises a live run is that the machinery itself works: the four postures
// run, the placement verdict is computed against the gold set, the run artefact
// is written and reads back verbatim, and the control behaves like a control.
//
// What this file deliberately does NOT assert: any placement RATE. The LLM here
// is a scripted stub, so every rate below is a property of the script, not a
// measurement of anything. The bench instructs C2; it does not decide it.
//
// Run: pnpm exec tsx --conditions labre-mcp-dev --test bench/bench.test.mts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LLMCall } from '#types/llm.mjs';
import { loadGoldSet } from './gold/build-gold-set.mjs';
import { computeChainGeometry } from './geometry/chain-geometry.mjs';
import {
  formatRun,
  plannedLlmCalls,
  readRunArtifact,
  runBench,
  scoreTraceability,
  summarise,
  writeRunArtifact,
} from './harness.mjs';
import { PILOT_POSTURES, createStubCall, parsePilotArgs } from './run-pilot.mjs';
import { postureA } from './postures/posture-a-engine.mjs';
import { postureB } from './postures/posture-b-skill.mjs';
import { postureC } from './postures/posture-c-skill-cli.mjs';
import { postureZ } from './postures/posture-z-control.mjs';
import type { BenchRun, GoldCase, Posture } from './bench.types.mjs';

const goldSet = loadGoldSet();
const cases: readonly GoldCase[] = goldSet.cases.slice(0, 3);
const postures: readonly Posture[] = [postureA, postureB, postureC, postureZ];

/**
 * The scripted answer per case, keyed by the component label the prompt carries.
 * The three deltas are chosen so the verdict is NOT uniform — a bench that
 * scored everything correct (or everything wrong) would pass while measuring
 * nothing:
 *   case 1 → exactly the truth        (correct)
 *   case 2 → truth + 0.05             (correct: inside the ±0.1 tolerance)
 *   case 3 → truth + 0.40             (wrong, and in another stage)
 */
const DELTAS = [0, 0.05, 0.4] as const;

function scriptedEvolution(goldCase: GoldCase, index: number): number {
  const raw = goldCase.truth.evolution + DELTAS[index];
  return Math.round(Math.min(0.98, raw) * 1000) / 1000;
}

/**
 * An offline LLM. It never touches the network: it reads the component label out
 * of the prompt — the ONE thing every posture's prompt shares, by construction
 * (`renderCasePayload`, and the engine's own user template) — and replies with
 * the scripted number in the `evolution=` shape all three arms parse.
 */
function createScriptedCall(): { call: LLMCall; count: () => number } {
  let calls = 0;
  const call: LLMCall = async (prompt: string) => {
    calls += 1;
    const index = cases.findIndex((c) => prompt.includes(c.component));
    if (index < 0) {
      throw new Error(`scripted stub: no known component in the prompt: ${prompt.slice(0, 120)}`);
    }
    return [
      'STUB — no model was called.',
      `evolution=${scriptedEvolution(cases[index], index)}`,
      'confidence=0.7',
      'reasoning=scripted, meaningless, offline',
    ].join('\n');
  };
  return { call, count: () => calls };
}

/** Fixed clock: two runs of this file produce byte-identical artefacts. */
function fixedClock() {
  return {
    now: () => new Date('2026-08-26T09:00:00.000Z'),
    newId: () => 'test-run-ch27',
  };
}

/**
 * Blank out the ONE non-reproducible field of a run: `capturedAt`, stamped by
 * `BaseStrategy` from the system clock deep inside posture A's signals. The
 * harness injects its own clock, but it does not — and must not — reach into
 * the strategy under test to replace that one.
 */
function withoutStrategyTimestamps(run: BenchRun): unknown {
  return JSON.parse(
    JSON.stringify(run, (key, value) => (key === 'capturedAt' ? '<clock>' : value)),
  );
}

async function runOnStubs(): Promise<{ run: BenchRun; observed: number }> {
  const stub = createScriptedCall();
  const run = await runBench({
    goldSet,
    cases,
    postures,
    llmCall: stub.call,
    clock: fixedClock(),
    maxLlmCalls: 100,
    concurrency: 3,
    llm: { provider: 'stub', model: 'stub', mode: 'stub' },
  });
  return { run, observed: stub.count() };
}

describe('bench harness — end to end on stubs, no network', () => {
  it('runs the four postures over every case and answers them all', async () => {
    const { run } = await runOnStubs();

    assert.equal(run.outcomes.length, postures.length * cases.length);
    const failed = run.outcomes.filter((o) => o.answer === null);
    assert.deepEqual(
      failed.map((o) => `${o.postureId}/${o.caseId}: ${o.error}`),
      [],
      'no posture may fail: a posture that cannot run measures nothing',
    );
    assert.equal(run.runId, 'test-run-ch27');
    assert.equal(run.llm.mode, 'stub');
  });

  it('spends exactly what the postures declare — the cost preview is not a guess', async () => {
    const { run, observed } = await runOnStubs();

    const planned = plannedLlmCalls(postures, cases.length);
    // A(1) + B(1) + C(1) + Z(0), three cases.
    assert.equal(planned, 9);
    assert.equal(run.plannedLlmCalls, planned);
    assert.equal(run.observedLlmCalls, planned);
    assert.equal(observed, planned, 'the recorder count is the real cost, not the declared one');
  });

  it('refuses to start above the ceiling instead of spending', async () => {
    await assert.rejects(
      () =>
        runBench({
          goldSet,
          cases,
          postures,
          llmCall: async () => {
            throw new Error('the ceiling must be checked BEFORE any call');
          },
          clock: fixedClock(),
          maxLlmCalls: 2,
          llm: { provider: 'stub', model: 'stub', mode: 'stub' },
        }),
      /refusing to run: 9 planned LLM calls exceeds the ceiling of 2/,
    );
  });

  it('scores placement against the gold set, tolerance included', async () => {
    const { run } = await runOnStubs();

    for (const postureId of ['A', 'B', 'C']) {
      const mine = run.outcomes
        .filter((o) => o.postureId === postureId)
        .sort((a, b) => cases.findIndex((c) => c.id === a.caseId) - cases.findIndex((c) => c.id === b.caseId));

      assert.deepEqual(
        mine.map((o) => o.correct),
        [true, true, false],
        `${postureId}: exact hit, inside-tolerance hit, and a miss`,
      );
      // The third case is off by 0.40 — far enough to land in another stage.
      assert.equal(mine[2].stageCorrect, false);
      assert.ok((mine[1].absoluteError ?? 1) <= goldSet.tolerance);
      assert.ok((mine[2].absoluteError ?? 0) > goldSet.tolerance);
    }

    const reportB = run.reports.find((r) => r.postureId === 'B');
    assert.equal(reportB?.correct, 2);
    assert.equal(reportB?.cases, 3);
    assert.equal(reportB?.correctRate, 0.667);
  });

  it('breaks the rate down per source map — the reference is not equally trustworthy', async () => {
    const { run } = await runOnStubs();
    const reportB = run.reports.find((r) => r.postureId === 'B');
    const total = Object.values(reportB?.byMap ?? {}).reduce((n, b) => n + b.cases, 0);
    assert.equal(total, cases.length);
    assert.ok(Object.keys(reportB?.byMap ?? {}).length > 1, 'a prefix must span several maps');
  });

  it('writes a run artefact that reads back verbatim', async () => {
    const { run } = await runOnStubs();
    const dir = mkdtempSync(path.join(tmpdir(), 'ch27-bench-'));
    try {
      const file = writeRunArtifact(run, dir);
      assert.equal(path.basename(file), 'test-run-ch27.json');

      const reloaded = readRunArtifact(file);
      assert.deepEqual(reloaded, JSON.parse(JSON.stringify(run)));

      // The artefact is the audit trail: it must carry the verbatim inputs of
      // every call, not just the scores.
      const b = reloaded.outcomes.find((o) => o.postureId === 'B');
      assert.equal(b?.answer?.trace.llmCalls.length, 1);
      assert.ok((b?.answer?.trace.llmCalls[0].system.length ?? 0) > 0);
      assert.ok((b?.answer?.trace.llmCalls[0].user.length ?? 0) > 0);
      assert.ok((b?.answer?.trace.llmCalls[0].response.length ?? 0) > 0);

      // Two runs of the same stub produce the same artefact, MODULO the
      // engine's own `capturedAt` stamps: `BaseStrategy` reads the system clock
      // when it builds a signal, and that clock is not one of the harness's
      // injected seams. Everything the bench itself owns — ids, dates,
      // latencies, scores, traces — is reproducible.
      const again = await runOnStubs();
      assert.deepEqual(withoutStrategyTimestamps(again.run), withoutStrategyTimestamps(run));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats a table a human can read', async () => {
    const { run } = await runOnStubs();
    const table = formatRun(run);
    for (const posture of postures) assert.match(table, new RegExp(`^${posture.id} `, 'm'));
    assert.match(table, /tolerance ±0\.1/);
  });
});

describe('posture Z — the control', () => {
  it('calls no model at all', async () => {
    const { run } = await runOnStubs();
    const z = run.outcomes.filter((o) => o.postureId === 'Z');
    assert.equal(z.length, cases.length);
    for (const outcome of z) {
      assert.equal(outcome.answer?.trace.llmCalls.length, 0);
    }
    assert.equal(postureZ.llmCallsPerCase, 0);
    // Z contributes nothing to the bill.
    assert.equal(plannedLlmCalls([postureZ], cases.length), 0);
  });

  it('answers the positional prior, recomputable offline from the gold set alone', async () => {
    const { run } = await runOnStubs();
    for (const outcome of run.outcomes.filter((o) => o.postureId === 'Z')) {
      const goldCase = cases.find((c) => c.id === outcome.caseId);
      assert.ok(goldCase);
      const geometry = computeChainGeometry(goldSet.maps[goldCase.mapKey], goldCase.componentId);
      assert.equal(outcome.answer?.evolution, geometry.prior.center);
    }
  });

  it('is insensitive to what the model says — that is what makes it a control', async () => {
    const shouted: LLMCall = async () => 'evolution=0.99\nconfidence=1.0';
    const withShouting = await runBench({
      goldSet,
      cases,
      postures: [postureZ],
      llmCall: shouted,
      clock: fixedClock(),
      maxLlmCalls: 0,
      llm: { provider: 'stub', model: 'stub', mode: 'stub' },
    });
    const baseline = await runOnStubs();
    const zOf = (run: BenchRun) =>
      run.outcomes.filter((o) => o.postureId === 'Z').map((o) => o.answer?.evolution);
    assert.deepEqual(zOf(withShouting), zOf(baseline.run));
  });

  it('scores full traceability — the floor the LLM arms are measured against', async () => {
    const { run } = await runOnStubs();
    const reportZ = run.reports.find((r) => r.postureId === 'Z');
    assert.equal(reportZ?.traceability.verdict, 'oui');
    assert.equal(reportZ?.traceability.evidence.length, 4);
  });
});

describe('traceability scoring — read from what a run produced, not from claims', () => {
  it('separates the arms mechanically', async () => {
    const { run } = await runOnStubs();
    const verdict = (id: string) =>
      run.reports.find((r) => r.postureId === id)?.traceability;

    // A: the strategy contract IS the structured trace (ARCH-22).
    assert.equal(verdict('A')?.structuredRationale, true);
    assert.equal(verdict('A')?.attributed, true);
    // B: prose only. That is the finding, not a bug.
    assert.equal(verdict('B')?.structuredRationale, false);
    assert.equal(verdict('B')?.deterministicPart, false);
    assert.equal(verdict('B')?.verdict, 'non');
    // C: same prose, plus a fact table anyone can recompute offline.
    assert.equal(verdict('C')?.structuredRationale, false);
    assert.equal(verdict('C')?.deterministicPart, true);
    assert.equal(verdict('C')?.verdict, 'partiel');
  });

  it('never credits a posture that produced no answer', () => {
    const score = scoreTraceability(postureB, [
      {
        caseId: cases[0].id,
        postureId: 'B',
        answer: null,
        error: 'boom',
        truth: cases[0].truth,
        absoluteError: null,
        correct: false,
        stageCorrect: false,
        latencyMs: 0,
      },
    ]);
    assert.equal(score.verdict, 'non');
    assert.equal(score.replayableInputs, false);
  });

  it('summarises an empty arm without dividing by zero', () => {
    const report = summarise(postureB, []);
    assert.equal(report.cases, 0);
    assert.equal(report.correctRate, 0);
    assert.equal(report.meanAbsoluteError, null);
    assert.equal(report.medianAbsoluteError, null);
  });
});

describe('pilot cost guard — nothing is spent by accident', () => {
  it('defaults to plan-only: neither confirmed nor run', () => {
    const options = parsePilotArgs([]);
    assert.equal(options.confirm, false);
    assert.equal(options.dryRun, false);
    assert.equal(options.cases, 10);
    assert.equal(options.maxCalls, 30);
    // Never the human's Claude subscription unless asked, out loud.
    assert.equal(options.allowClaudeProvider, false);
  });

  it('announces the exact call count the default pilot would make', () => {
    assert.equal(plannedLlmCalls(PILOT_POSTURES, parsePilotArgs([]).cases), 30);
    assert.ok(plannedLlmCalls(PILOT_POSTURES, 10) <= parsePilotArgs([]).maxCalls);
  });

  it('reads both `--cases 3` and `--cases=3`, and ignores pnpm\'s bare `--`', () => {
    assert.equal(parsePilotArgs(['--cases', '3']).cases, 3);
    assert.equal(parsePilotArgs(['--cases=3']).cases, 3);
    assert.equal(parsePilotArgs(['--', '--dry-run']).dryRun, true);
  });

  it('refuses an argument it does not understand instead of guessing', () => {
    assert.throws(() => parsePilotArgs(['--confrim']), /unknown argument/);
    assert.throws(() => parsePilotArgs(['--cases', 'ten']), /non-negative integer/);
  });

  it('ships an offline stub that says it is one', async () => {
    const answer = await createStubCall()('anything');
    assert.match(answer, /STUB — no model was called/);
    assert.match(answer, /evolution=/);
  });
});

describe('the leakage invariant — no posture can read the answer off the map', () => {
  it('keeps every evolution coordinate out of the map view', () => {
    const serialised = JSON.stringify(goldSet.maps);
    assert.ok(
      !serialised.includes('evolution'),
      'the map view must carry no evolution field: the truth lives only in cases[].truth',
    );
  });

  it('hands the geometry tool nothing but position', async () => {
    const map = goldSet.maps[cases[0].mapKey];
    const geometry = computeChainGeometry(map, cases[0].componentId);
    assert.ok(!JSON.stringify(geometry.notes).includes(String(cases[0].truth.evolution)));
    assert.ok(geometry.prior.low < geometry.prior.center);
    assert.ok(geometry.prior.center < geometry.prior.high);
  });
});
