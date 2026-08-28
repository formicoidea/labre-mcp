// Fixture strategies — shape conformance, clock discipline, and the DATA-ONLY
// guard (CH-26, ARCH-29 option (a)).
//
// The first two tests are the migration's contract test: they are what proves
// the 61 hand-written mocks and their 61-line data replacement answer
// identically. The last two are the guards the ADR asked for.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy, StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { runWithClock } from '#core/clock/run-clock-context.mjs';
import {
  FIXTURE_METHOD_IDS,
  createFixtureStrategy,
  registerFixtures,
  type FixtureResult,
} from './fixtures-registry.mjs';

const ctx: RequestContext = {
  projectId: 'test',
  projectRoot: '/tmp/test',
  sessionId: 'session',
  domain: 'wardley',
};

function build(): StrategyRegistry<BaseStrategy> {
  const registry = new StrategyRegistry<BaseStrategy>();
  registerFixtures(registry);
  return registry;
}

describe('fixtures-registry', () => {
  // 61 = the full v0.1.0 catalogue minus the five entries now backed by real
  // strategies (purpose:generate, audit-purpose-quality, image emit:png,
  // image parse:png, image parse:svg).
  it('registers the full v0.1.0 fixture catalogue (61 entries)', () => {
    assert.equal(FIXTURE_METHOD_IDS.length, 61);
    assert.equal(build().size(), 61);
  });

  it('declares every fixture as a mock in the catalogue', () => {
    const registry = build();
    for (const entry of registry.catalogue()) {
      assert.equal(entry.implementation, 'mock', `${entry.methodId}: must be declared mock`);
      // The migration adds no second refusal channel (ARCH-29 G2).
      assert.equal(entry.disabledReason, undefined, `${entry.methodId}: must not be disabled`);
    }
  });

  it('every registered fixture returns a conformant StrategyResult', async () => {
    const registry = build();
    for (const methodId of registry.list()) {
      const StrategyClass = registry.get(methodId);
      const strategy = new (StrategyClass as unknown as new () => BaseStrategy)();
      const out = (await strategy.evaluate({}, ctx)) as StrategyResult<FixtureResult>;

      assert.ok(Array.isArray(out.signals), `${methodId}: signals must be an array`);
      assert.ok(Array.isArray(out.reasoning), `${methodId}: reasoning must be an array`);
      assert.ok(Array.isArray(out.insights), `${methodId}: insights must be an array`);
      assert.ok(out.result, `${methodId}: result must be present`);

      // The mock signal is the marker that disambiguates scaffold output from real.
      const mockSignal = out.signals.find((s) => s.name === 'mock');
      assert.ok(mockSignal, `${methodId}: signals must include the mock=true marker`);
      assert.equal(mockSignal.value, true, `${methodId}: mock signal value must be true`);

      // The result envelope echoes the methodId so callers can attribute output.
      assert.equal(out.result.mock, true, `${methodId}: result.mock must be true`);
      assert.equal(out.result.methodId, methodId, `${methodId}: result.methodId mismatch`);
    }
  });

  // I3 (recipes.md). The point of the migration: a fixture's `capturedAt` is
  // the RUN'S clock reading, so a replay with an injected clock reproduces it
  // byte for byte. Before CH-26 this was 61 private `new Date()` calls and this
  // assertion was impossible to write.
  it('stamps capturedAt from the injected run clock', async () => {
    const frozen = new Date('2020-01-02T03:04:05.000Z');
    const Fixture = createFixtureStrategy('wardley:map:quality:audit:default');

    const out = await runWithClock(
      () => frozen,
      () => new Fixture().evaluate({}, ctx),
    );

    assert.equal(out.signals[0]?.capturedAt, frozen.toISOString());
  });

  it('gives two runs under the same clock identical signals', async () => {
    const frozen = new Date('2020-01-02T03:04:05.000Z');
    const run = () =>
      runWithClock(
        () => frozen,
        () => new (createFixtureStrategy('wardley:map:quality:audit:default'))().evaluate({}, ctx),
      );

    assert.deepEqual((await run()).signals, (await run()).signals);
  });

  // ─── The two ADR guards, as source-level assertions ──────────────────────

  // Both guards scan CODE, not prose: this file's own header names the tokens
  // it forbids, and a guard that trips on the documentation explaining the rule
  // is a guard that punishes documenting.
  function stripComments(src: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < src.length) {
      if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 2;
        out.push(' ');
      } else if (src.startsWith('//', i)) {
        const end = src.indexOf('\n', i);
        i = end === -1 ? src.length : end;
        out.push(' ');
      } else {
        out.push(src[i]!);
        i += 1;
      }
    }
    return out.join('');
  }

  const SOURCE = stripComments(
    readFileSync(fileURLToPath(new URL('./fixtures-registry.mts', import.meta.url)), 'utf8'),
  );

  // The stripper is load-bearing for both guards below: over-strip and they
  // pass vacuously on an empty string. Anchor them on code that must survive.
  it('scans a source that still contains the fixture code', () => {
    assert.ok(SOURCE.includes('registerMock('), 'comment stripping ate the code');
    assert.ok(SOURCE.includes('clockNow()'), 'comment stripping ate the code');
    assert.ok(!SOURCE.includes('DATA-ONLY'), 'comment stripping left prose behind');
  });

  // I3 again, as a regression gate. `new Date()` on the fixture path is exactly
  // the leak this tranche closed; the only sanctioned wall-clock read is the
  // documented fallback in core/clock/run-clock-context.mts.
  it('reads no wall clock of its own', () => {
    for (const forbidden of ['new Date(', 'Date.now(', 'performance.now(']) {
      assert.equal(
        SOURCE.includes(forbidden),
        false,
        `fixtures-registry.mts must not call ${forbidden}) — take the run clock via clockNow()`,
      );
    }
  });

  // ARCH-29 G2: no module reachable from a plugin path gains a dynamic
  // evaluation primitive. A fixture is data read by a parser, never code loaded.
  it('holds no dynamic evaluation primitive (ARCH-29 G2)', () => {
    for (const forbidden of ['import(', 'Function(', 'eval(', 'node:vm', 'require(']) {
      assert.equal(
        SOURCE.includes(forbidden),
        false,
        `fixtures-registry.mts must not use ${forbidden} — a fixture is DATA (ARCH-29 G2)`,
      );
    }
  });
});
