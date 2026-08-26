// The harness — runs cases × postures, scores placement and traceability,
// writes one replayable artefact per run.
//
// Determinism: everything the harness itself owns is deterministic. The clock
// and the run-id factory are injected (`RunClock`, the CH-12 convention already
// used by the recipe runner), so at fixed LLM outputs two runs produce the same
// ids, dates, latencies, scores and traces. That is what makes `bench.test.mts`
// able to pin a whole run on stubs, with no network.
//
// ONE exception, measured not assumed: posture A's signals carry a `capturedAt`
// stamped by `BaseStrategy` from the system clock, inside the strategy under
// test. The harness does not reach in to replace it — patching the incumbent to
// make the bench prettier would be exactly the kind of thing that invalidates a
// falsification test. `bench.test.mts` blanks that one field before comparing
// two runs, and says so.
//
// Cost: the harness NEVER decides to spend. It computes the planned call count,
// hands it to the caller, and refuses to exceed `maxLlmCalls`. The decision to
// run a live campaign is a human one.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMCall, LLMCallOptions, TemplateVariables } from '#types/llm.mjs';
import type {
  BenchRun,
  CaseOutcome,
  GoldCase,
  GoldSet,
  Posture,
  PostureReport,
  TraceabilityScore,
} from './bench.types.mjs';
import { stageOf } from './bench.types.mjs';

const benchDir = path.dirname(fileURLToPath(import.meta.url));

// ── LLM call recording ─────────────────────────────────────────────────

export interface RecordedCall {
  system: string;
  user: string;
  response: string;
}

export interface CallRecorder {
  call: LLMCall;
  entries: RecordedCall[];
}

/**
 * Wrap an LLM call so every invocation is captured verbatim — the raw material
 * of "replayable inputs". The wrapper is per (case, posture): a posture never
 * sees another posture's calls, and the count it produces IS the observed cost.
 */
export function createRecordingCall(inner: LLMCall): CallRecorder {
  const entries: RecordedCall[] = [];
  const call: LLMCall = async (
    prompt: string,
    variables?: TemplateVariables,
    opts?: LLMCallOptions,
  ) => {
    const response = await inner(prompt, variables, opts);
    entries.push({ system: opts?.systemPrompt ?? '', user: prompt, response });
    return response;
  };
  return { call, entries };
}

// ── Traceability ───────────────────────────────────────────────────────

/**
 * Score the SECOND criterion of the falsification test, mechanically, from what
 * the run actually produced — never from what a posture claims about itself.
 *
 * Four criteria, each a yes/no over every answered case:
 *   structuredRationale — a machine-readable rationale, not only prose;
 *   replayableInputs    — every LLM input recorded verbatim, so the call can be replayed;
 *   deterministicPart   — a part of the answer recomputable offline, deterministically;
 *   attributed          — the rationale says WHO produced each claim.
 *
 * 4/4 = oui, 2-3 = partiel, 0-1 = non.
 */
export function scoreTraceability(
  posture: Posture,
  outcomes: readonly CaseOutcome[],
): TraceabilityScore {
  const answered = outcomes.filter((o) => o.answer !== null);
  const every = (predicate: (o: CaseOutcome) => boolean): boolean =>
    answered.length > 0 && answered.every(predicate);

  const structuredRationale = every((o) => o.answer?.trace.structured != null);
  const replayableInputs =
    posture.llmCallsPerCase === 0
      ? answered.length > 0
      : every(
          (o) =>
            (o.answer?.trace.llmCalls.length ?? 0) >= posture.llmCallsPerCase &&
            (o.answer?.trace.llmCalls ?? []).every(
              (c) => c.user.length > 0 && c.response.length > 0,
            ),
        );
  const deterministicPart = every((o) => o.answer?.trace.deterministic != null);
  const attributed = every((o) => {
    const structured = o.answer?.trace.structured;
    const deterministic = o.answer?.trace.deterministic;
    const named =
      structured != null &&
      (typeof structured.methodId === 'string' ||
        (Array.isArray(structured.reasoning) &&
          structured.reasoning.every(
            (r: unknown) => typeof (r as { by?: unknown }).by === 'string',
          )));
    const toolNamed = deterministic != null && typeof deterministic.tool === 'string';
    return named || toolNamed;
  });

  const passed = [structuredRationale, replayableInputs, deterministicPart, attributed].filter(
    Boolean,
  ).length;

  return {
    structuredRationale,
    replayableInputs,
    deterministicPart,
    attributed,
    verdict: passed === 4 ? 'oui' : passed >= 2 ? 'partiel' : 'non',
    evidence: [
      `structuredRationale=${structuredRationale} — ${
        structuredRationale
          ? 'every answer carries a typed rationale object'
          : 'the "why" is free prose only, nothing downstream can read it'
      }`,
      `replayableInputs=${replayableInputs} — ${
        posture.llmCallsPerCase === 0
          ? 'no LLM call to replay (deterministic posture)'
          : replayableInputs
            ? 'system + user + response captured verbatim for every call'
            : 'at least one call was not captured in full'
      }`,
      `deterministicPart=${deterministicPart} — ${
        deterministicPart
          ? 'part of the answer is recomputable offline from the gold set alone'
          : 'nothing in the answer can be recomputed without the model'
      }`,
      `attributed=${attributed} — ${
        attributed ? 'each claim names its producer' : 'no claim names its producer'
      }`,
    ],
  };
}

// ── Running ────────────────────────────────────────────────────────────

export interface BenchOptions {
  goldSet: GoldSet;
  cases: readonly GoldCase[];
  postures: readonly Posture[];
  llmCall: LLMCall;
  clock: { now: () => Date; newId: () => string };
  /** Hard ceiling. The run refuses to start above it — cost is not negotiable. */
  maxLlmCalls: number;
  llm: { provider: string; model: string; mode: 'stub' | 'live' };
  /** How many cases of one posture run at once. Kept low: rate limits. */
  concurrency?: number;
  /** Progress line, so a live run is not a silent five minutes. */
  onProgress?: (line: string) => void;
}

/** LLM calls a run will make, per the postures' declared cost. */
export function plannedLlmCalls(
  postures: readonly Posture[],
  caseCount: number,
): number {
  return postures.reduce((total, p) => total + p.llmCallsPerCase * caseCount, 0);
}

async function runOne(
  posture: Posture,
  goldCase: GoldCase,
  options: BenchOptions,
): Promise<CaseOutcome> {
  const recorder = createRecordingCall(options.llmCall);
  const startedAt = options.clock.now().getTime();
  const base = {
    caseId: goldCase.id,
    postureId: posture.id,
    truth: goldCase.truth,
  };

  try {
    const answer = await posture.run(goldCase, {
      llmCall: recorder.call,
      clock: options.clock,
      goldSet: options.goldSet,
    });
    // The recorder, not the posture, owns the call log: a posture cannot
    // under-report what it sent.
    answer.trace.llmCalls = recorder.entries;
    const absoluteError = Math.abs(answer.evolution - goldCase.truth.evolution);
    return {
      ...base,
      answer,
      error: null,
      absoluteError: Math.round(absoluteError * 1000) / 1000,
      correct: absoluteError <= options.goldSet.tolerance,
      stageCorrect: stageOf(answer.evolution) === goldCase.truth.stage,
      latencyMs: options.clock.now().getTime() - startedAt,
    };
  } catch (err) {
    return {
      ...base,
      answer: null,
      error: err instanceof Error ? err.message : String(err),
      absoluteError: null,
      correct: false,
      stageCorrect: false,
      latencyMs: options.clock.now().getTime() - startedAt,
    };
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return Math.round(value * 1000) / 1000;
}

export function summarise(
  posture: Posture,
  outcomes: readonly CaseOutcome[],
): PostureReport {
  const mine = outcomes.filter((o) => o.postureId === posture.id);
  const answered = mine.filter((o) => o.answer !== null);
  const errors = answered.map((o) => o.absoluteError ?? 0);
  const correct = mine.filter((o) => o.correct).length;
  const stageCorrect = mine.filter((o) => o.stageCorrect).length;

  const byMap: Record<string, { cases: number; correct: number }> = {};
  for (const outcome of mine) {
    const mapKey = outcome.caseId.split(':')[0];
    const bucket = (byMap[mapKey] ??= { cases: 0, correct: 0 });
    bucket.cases += 1;
    if (outcome.correct) bucket.correct += 1;
  }

  return {
    postureId: posture.id,
    label: posture.label,
    cases: mine.length,
    answered: answered.length,
    correct,
    correctRate: mine.length === 0 ? 0 : Math.round((correct / mine.length) * 1000) / 1000,
    stageCorrect,
    stageCorrectRate:
      mine.length === 0 ? 0 : Math.round((stageCorrect / mine.length) * 1000) / 1000,
    meanAbsoluteError:
      errors.length === 0
        ? null
        : Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 1000) / 1000,
    medianAbsoluteError: median(errors),
    llmCalls: answered.reduce((total, o) => total + (o.answer?.trace.llmCalls.length ?? 0), 0),
    totalLatencyMs: mine.reduce((total, o) => total + o.latencyMs, 0),
    byMap,
    traceability: scoreTraceability(posture, mine),
  };
}

export async function runBench(options: BenchOptions): Promise<BenchRun> {
  const planned = plannedLlmCalls(options.postures, options.cases.length);
  if (planned > options.maxLlmCalls) {
    throw new Error(
      `refusing to run: ${planned} planned LLM calls exceeds the ceiling of ${options.maxLlmCalls}. ` +
        'Reduce --cases, or raise --max-calls deliberately.',
    );
  }

  const startedAt = options.clock.now().toISOString();
  const runId = options.clock.newId();
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const outcomes: CaseOutcome[] = [];

  // Postures sequentially (so a provider failure is contained to one arm and
  // the artefact reads arm by arm), cases in small parallel batches inside a
  // posture (AGENT.md rule 15, throttled for rate limits).
  for (const posture of options.postures) {
    for (let offset = 0; offset < options.cases.length; offset += concurrency) {
      const batch = options.cases.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(
        batch.map((goldCase) => runOne(posture, goldCase, options)),
      );
      for (const [index, result] of settled.entries()) {
        const outcome =
          result.status === 'fulfilled'
            ? result.value
            : {
                caseId: batch[index].id,
                postureId: posture.id,
                answer: null,
                error: String(result.reason),
                truth: batch[index].truth,
                absoluteError: null,
                correct: false,
                stageCorrect: false,
                latencyMs: 0,
              };
        outcomes.push(outcome);
        options.onProgress?.(
          `  ${posture.id} ${outcome.caseId.padEnd(38)} ${
            outcome.answer === null
              ? `ERROR ${outcome.error}`
              : `${outcome.answer.evolution.toFixed(2)} vs ${outcome.truth.evolution.toFixed(2)} ${
                  outcome.correct ? 'OK ' : '   '
                }`
          }`,
        );
      }
    }
  }

  return {
    runId,
    startedAt,
    finishedAt: options.clock.now().toISOString(),
    llm: options.llm,
    tolerance: options.goldSet.tolerance,
    caseIds: options.cases.map((c) => c.id),
    plannedLlmCalls: planned,
    observedLlmCalls: outcomes.reduce(
      (total, o) => total + (o.answer?.trace.llmCalls.length ?? 0),
      0,
    ),
    outcomes,
    reports: options.postures.map((posture) => summarise(posture, outcomes)),
  };
}

// ── Reporting ──────────────────────────────────────────────────────────

function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

/** The run, as a table a human can read in a terminal or paste in a PR. */
export function formatRun(run: BenchRun): string {
  const lines = [
    `run ${run.runId} — ${run.llm.mode} · ${run.llm.provider}/${run.llm.model}`,
    `cases ${run.caseIds.length} · tolerance ±${run.tolerance} · LLM calls ${run.observedLlmCalls}/${run.plannedLlmCalls}`,
    '',
    'posture                                            placement  stage   MAE    appels  traçabilité',
    '-------------------------------------------------  ---------  ------  -----  ------  -----------',
  ];
  for (const report of run.reports) {
    lines.push(
      `${report.postureId} ${report.label}`.padEnd(51).slice(0, 51) +
        `${`${report.correct}/${report.cases} ${pct(report.correctRate)}`.padEnd(11)}` +
        `${pct(report.stageCorrectRate).padEnd(8)}` +
        `${(report.meanAbsoluteError ?? 0).toFixed(3).padEnd(7)}` +
        `${String(report.llmCalls).padEnd(8)}` +
        report.traceability.verdict,
    );
  }
  lines.push('', 'Par carte source (placement correct / cas) :');
  for (const report of run.reports) {
    const byMap = Object.entries(report.byMap)
      .map(([key, stats]) => `${key} ${stats.correct}/${stats.cases}`)
      .join(' · ');
    lines.push(`  ${report.postureId}: ${byMap}`);
  }
  lines.push('', 'Traçabilité, critère par critère :');
  for (const report of run.reports) {
    lines.push(`  ${report.postureId} → ${report.traceability.verdict}`);
    for (const evidence of report.traceability.evidence) lines.push(`      ${evidence}`);
  }
  return lines.join('\n');
}

/** Where run artefacts land by default. Git-ignored: a run is evidence of one
 *  campaign, not a tracked file — the tracked reference is `gold/gold-set.json`. */
export const DEFAULT_RUNS_DIR = path.join(benchDir, 'runs');

/**
 * Write the run artefact. Returns the path written.
 *
 * `outDir` is the ONLY injected thing here, and it exists so `bench.test.mts`
 * can round-trip an artefact through a temp directory instead of the repo. The
 * default is the real one, so the pilot's behaviour is what the test exercises.
 */
export function writeRunArtifact(run: BenchRun, outDir: string = DEFAULT_RUNS_DIR): string {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${run.runId}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return file;
}

/** Read a run artefact back. The artefact must survive the round trip verbatim:
 *  that is what makes a campaign auditable months later. */
export function readRunArtifact(file: string): BenchRun {
  return JSON.parse(readFileSync(file, 'utf8')) as BenchRun;
}
