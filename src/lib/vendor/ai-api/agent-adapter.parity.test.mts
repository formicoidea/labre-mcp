// PARITY GUARD for the vendored `@labre/ai-api` contract (ARCH-30).
//
// A vendored contract without a check is a fork with good intentions. This file
// is what makes the copy defensible, and it is built in TWO tiers on purpose,
// because the honest failure mode of a cross-repo guard is "it only runs on the
// author's laptop":
//
//   TIER 1 — ALWAYS BITES, everywhere, CI included. The vendored surface is
//   pinned by value: the event vocabulary, the error taxonomy, the command
//   allow-list and its exact size. Changing the copy without changing this file
//   fails the suite. This tier proves the copy is STABLE, not that it is TRUE.
//
//   TIER 2 — BITES HARDER when `../labre` is on disk (the developer's machine,
//   the release checkout). The upstream source is read, CRLF-normalised, hashed
//   against the recorded provenance, and its `commandSchemas` keys are diffed
//   against the allow-list. This tier proves the copy is TRUE. It SKIPS when
//   the sibling checkout is absent — and says so out loud rather than passing
//   silently, because a green tick that means "I checked nothing" is the exact
//   pattern the AI-harness audit found and named elsewhere in this repo.
//
// Refreshing the vendored contract = update the copy, run this file with
// `../labre` present, update UPSTREAM_SHA256, commit both together.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentAdapter,
  type AgentEvent,
  agentEventKinds,
  aiErrorCodes,
} from './agent-adapter.mjs';
import { AI_COMMAND_NAMES, isKnownCommandName } from './ai-command-names.mjs';

/** sha256 of `labre/packages/ai-api/src/adapter.ts`, CRLF normalised to LF. */
const UPSTREAM_SHA256 =
  '4d169620b32e0cf21cd47be11b677c8795d15ddb5f7acab2329bd1093a1fbefe';

/** `<repo>/src/lib/vendor/ai-api` → the sibling labre checkout. */
const here = dirname(fileURLToPath(import.meta.url));
const upstreamSrc = resolve(here, '../../../../../labre/packages/ai-api/src');

function readUpstream(file: string): string {
  return readFileSync(resolve(upstreamSrc, file), 'utf8').replace(/\r\n/g, '\n');
}

describe('vendored ai-api contract — tier 1 (always)', () => {
  it('pins the normalized event vocabulary', () => {
    assert.deepEqual(
      [...agentEventKinds],
      ['message', 'tool-call-proposed', 'error', 'turn-end'],
      'ADR-0026 Decision 2 closes this set; a new kind is a contract change',
    );
  });

  it('pins the published error taxonomy', () => {
    assert.deepEqual(
      [...aiErrorCodes],
      ['invalid-command', 'not-implemented', 'unavailable', 'failed'],
    );
  });

  it('pins the command allow-list size and membership', () => {
    assert.equal(AI_COMMAND_NAMES.length, 36);
    assert.equal(
      new Set<string>(AI_COMMAND_NAMES).size,
      AI_COMMAND_NAMES.length,
      'a duplicated verb means the extraction went wrong',
    );
    assert.ok(isKnownCommandName('doc.create'));
    assert.ok(isKnownCommandName('whiteboard.createWardleyMap'));
    assert.equal(isKnownCommandName('doc.deleteEverything'), false);
    assert.equal(isKnownCommandName(42), false);
  });

  it('the AgentAdapter shape is structurally satisfiable', () => {
    // Compile-time proof that the vendored interface is implementable as
    // written; a signature drift in the copy breaks `pnpm typecheck` here
    // before it can break a caller.
    const seen: AgentEvent['kind'][] = [];
    const adapter: AgentAdapter = {
      capabilities: { streaming: false, interrupt: false },
      async createSession(input) {
        return { ...input };
      },
      async sendTurn(_session, _input, onEvent) {
        onEvent({ kind: 'message', text: 'hi' });
        onEvent({ kind: 'turn-end', usage: {} });
        return { finishReason: 'stop', usage: {} };
      },
      async cancel() {
        /* idempotent no-op */
      },
    };
    const session = { conversationId: 'c', sessionId: 's', scope: 'restricted', writeMode: 'ask' } as const;
    return adapter
      .sendTurn(session, {}, (e) => seen.push(e.kind))
      .then((result) => {
        assert.deepEqual(seen, ['message', 'turn-end']);
        assert.equal(result.finishReason, 'stop');
      });
  });
});

describe('vendored ai-api contract — tier 2 (needs ../labre)', () => {
  const available = existsSync(resolve(upstreamSrc, 'adapter.ts'));

  it('states whether the upstream checkout was reachable', () => {
    // Not an assertion on availability — a printed verdict, so a run that
    // checked nothing cannot be mistaken for a run that checked everything.
    console.log(
      available
        ? `[parity] upstream reachable at ${upstreamSrc} — tier 2 enforced`
        : `[parity] upstream ABSENT at ${upstreamSrc} — tier 2 SKIPPED (tier 1 still enforced)`,
    );
    assert.ok(true);
  });

  it('the vendored adapter matches the recorded upstream hash', { skip: !available }, () => {
    const digest = createHash('sha256').update(readUpstream('adapter.ts')).digest('hex');
    assert.equal(
      digest,
      UPSTREAM_SHA256,
      'labre/packages/ai-api/src/adapter.ts has moved. Re-read it, refresh ' +
        'src/lib/vendor/ai-api/agent-adapter.mts, and update UPSTREAM_SHA256.',
    );
  });

  it('the command allow-list matches upstream commandSchemas', { skip: !available }, () => {
    const source = readUpstream('schemas.ts');
    const start = source.indexOf('export const commandSchemas');
    const end = source.indexOf('export const querySchemas');
    assert.ok(start >= 0, 'commandSchemas not found upstream');
    const block = source.slice(start, end > start ? end : source.length);
    const upstreamNames = [...block.matchAll(/^ {2}'([a-zA-Z]+\.[a-zA-Z]+)':/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      upstreamNames,
      [...AI_COMMAND_NAMES],
      'labre gained or lost an ai-command verb. Refresh ai-command-names.mts ' +
        'and the pinned count in tier 1.',
    );
  });

  it('the vendored error taxonomy matches upstream', { skip: !available }, () => {
    const source = readUpstream('schemas.ts');
    const match = /export const aiErrorCodeSchema = z\.enum\(\[([^\]]*)\]/.exec(source);
    assert.ok(match, 'aiErrorCodeSchema not found upstream');
    const upstream = [...match[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual(upstream, [...aiErrorCodes]);
  });
});
