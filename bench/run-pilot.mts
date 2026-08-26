#!/usr/bin/env tsx
// The pilot runner — the ONLY entry point that can spend money.
//
// It does three things in this order, and the order is the cost guard:
//   1. resolve the LLM route from the repo's own `llm.config.json`;
//   2. print the plan — how many calls, on which provider and model — and STOP
//      unless the caller passed `--confirm`;
//   3. run, write the artefact, print the table.
//
// A full campaign is a human decision. The default ceiling is 30 calls
// (10 cases × 3 arms × 1 call), which is the pilot the CH-27 brief authorises.
//
// Run:
//   pnpm bench:pilot                    # plan only, spends nothing
//   pnpm bench:pilot -- --dry-run       # full run on an offline stub, spends nothing
//   pnpm bench:pilot -- --confirm       # the real pilot

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLLMConfig } from '#lib/llm/config.loader.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { loadGoldSet } from './gold/build-gold-set.mjs';
import { formatRun, plannedLlmCalls, runBench, writeRunArtifact } from './harness.mjs';
import { postureA } from './postures/posture-a-engine.mjs';
import { postureB } from './postures/posture-b-skill.mjs';
import { postureC } from './postures/posture-c-skill-cli.mjs';
import { postureZ } from './postures/posture-z-control.mjs';
import type { Posture } from './bench.types.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The strategy id the bench routes through. It is a BENCH id, not a business
 * one: pointing the three arms at one entry is what pins them to one provider,
 * one model and one temperature.
 */
export const BENCH_STRATEGY_ID = 'bench-placement';

/** The three arms of the falsification test, plus the free control. */
export const PILOT_POSTURES: readonly Posture[] = [postureA, postureB, postureC, postureZ];

export interface PilotOptions {
  cases: number;
  confirm: boolean;
  dryRun: boolean;
  maxCalls: number;
  concurrency: number;
  /** Explicit opt-in required before spending the human's Claude subscription. */
  allowClaudeProvider: boolean;
}

export function parsePilotArgs(argv: readonly string[]): PilotOptions {
  const options: PilotOptions = {
    cases: 10,
    confirm: false,
    dryRun: false,
    maxCalls: 30,
    concurrency: 3,
    allowClaudeProvider: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // pnpm 10 forwards a bare `--` verbatim instead of eating it. Both
    // `pnpm bench:pilot --confirm` and `pnpm bench:pilot -- --confirm` must
    // mean the same thing: a separator is not an argument.
    if (arg === '--') continue;
    if (arg === '--confirm') {
      options.confirm = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--allow-claude-provider') {
      options.allowClaudeProvider = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    // The name is validated BEFORE the value is consumed: a typo'd flag must
    // say "unknown argument", not swallow the next token and complain about an
    // integer. On a runner whose whole point is a cost ceiling, a misleading
    // refusal is nearly as bad as no refusal.
    if (name !== '--cases' && name !== '--max-calls' && name !== '--concurrency') {
      throw new Error(`unknown argument "${arg}"`);
    }
    const raw = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    const value = Number.parseInt(raw ?? '', 10);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} expects a non-negative integer (got ${raw ?? '<nothing>'})`);
    }
    if (name === '--cases') options.cases = value;
    else if (name === '--max-calls') options.maxCalls = value;
    else options.concurrency = value;
  }
  return options;
}

/** An offline stub: deterministic, free, and honest about being meaningless. */
export function createStubCall(): LLMCall {
  return async (user: string) =>
    [
      'STUB — no model was called. This answer is a fixed string, produced so the',
      'harness can be exercised end to end with no network and no spend.',
      `(prompt length: ${user.length})`,
      'evolution=0.60',
      'confidence=0.50',
    ].join('\n');
}

interface ResolvedRoute {
  provider: string;
  model: string;
  kind: string;
}

/** What `llm.config.json` says the bench strategy resolves to. */
export function resolveRoute(): ResolvedRoute {
  const config = loadLLMConfig();
  const entry = config.strategies[BENCH_STRATEGY_ID];
  const provider = entry?.provider ?? config.defaultProvider;
  const model = entry?.model ?? config.defaultModel;
  if (model === undefined) {
    throw new Error(
      `no model resolves for "${BENCH_STRATEGY_ID}" — add a strategies["${BENCH_STRATEGY_ID}"] ` +
        'entry to llm.config.json (see bench/README.md)',
    );
  }
  return { provider, model, kind: config.providers[provider]?.kind ?? 'unknown' };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const options = parsePilotArgs(process.argv.slice(2));
  const goldSet = loadGoldSet();
  const cases = goldSet.cases.slice(0, options.cases);
  const planned = plannedLlmCalls(PILOT_POSTURES, cases.length);

  // Bench-only convenience: the repo loads no dotenv, and a provider key lives
  // in `.env` on this machine. Boot-time read of a local file, never a runtime
  // env read inside a tool call (AGENT.md rule 20).
  const envFile = path.join(repoRoot, '.env');
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // A malformed .env is not a reason to refuse to plan.
    }
  }

  let route: ResolvedRoute | null = null;
  let routeError: string | null = null;
  try {
    route = resolveRoute();
  } catch (err) {
    routeError = err instanceof Error ? err.message : String(err);
  }

  const plan = [
    '── plan du pilote CH-27 ───────────────────────────────────────────',
    `  cas          : ${cases.length} (préfixe du jeu étalon de ${goldSet.cases.length})`,
    `  postures     : ${PILOT_POSTURES.map((p) => `${p.id}(${p.llmCallsPerCase} appel/cas)`).join(' ')}`,
    `  appels LLM   : ${planned} prévus, plafond ${options.maxCalls}`,
    `  route LLM    : ${route ? `${route.provider}/${route.model} (${route.kind})` : `NON RÉSOLUE — ${routeError}`}`,
    `  mode         : ${options.dryRun ? 'DRY-RUN (stub hors ligne, 0 €)' : options.confirm ? 'RÉEL' : 'PLAN SEUL'}`,
    '───────────────────────────────────────────────────────────────────',
  ];
  process.stdout.write(`${plan.join('\n')}\n`);

  if (!options.confirm && !options.dryRun) {
    process.stdout.write(
      'Rien n\'a été dépensé. Relancer avec --dry-run (hors ligne) ou --confirm (réel).\n',
    );
    process.exit(0);
  }

  if (!options.dryRun) {
    if (route === null) throw new Error(routeError ?? 'unresolved LLM route');
    // Hard guard: the agent-sdk provider bills the human's Claude subscription.
    // It is never the default of a bench run.
    if (route.kind === 'agent-sdk' && !options.allowClaudeProvider) {
      throw new Error(
        `route "${route.provider}" is the Claude Agent SDK — it consumes the human's Claude ` +
          'subscription. Point the bench at another provider, or pass --allow-claude-provider ' +
          'deliberately (and say so in the report).',
      );
    }
  }

  const llmCall = options.dryRun ? createStubCall() : getStrategyLLM(BENCH_STRATEGY_ID);
  const run = await runBench({
    goldSet,
    cases,
    postures: PILOT_POSTURES,
    llmCall,
    clock: { now: () => new Date(), newId: randomUUID },
    maxLlmCalls: options.maxCalls,
    concurrency: options.concurrency,
    llm: options.dryRun
      ? { provider: 'stub', model: 'stub', mode: 'stub' }
      : { provider: route?.provider ?? 'unknown', model: route?.model ?? 'unknown', mode: 'live' },
    onProgress: (line) => process.stdout.write(`${line}\n`),
  });

  const artifact = writeRunArtifact(run);
  process.stdout.write(`\n${formatRun(run)}\n\nartefact : ${path.relative(repoRoot, artifact)}\n`);
  if (options.dryRun) {
    process.stdout.write(
      'DRY-RUN : les taux ci-dessus ne mesurent RIEN (réponse stub fixe) — ils prouvent seulement que le banc tourne.\n',
    );
  }
}
