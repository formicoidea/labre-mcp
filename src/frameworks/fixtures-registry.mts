// Fixture strategies — the scaffold half of the v0.1.0 catalogue, as DATA.
//
// WHAT THIS REPLACES. Until CH-26 this was 61 files of 44 lines each plus a
// 142-line registry of 61 hand-written imports and 61 hand-written
// registrations. Normalised for identifier names, all 61 files were the SAME
// program byte for byte: ignore the input, return `{ mock: true, methodId }`
// with a `mock=true` signal and one insight. 61 copies of one program is a
// list, not a codebase.
//
// So the list is below and the program is written once. Adding or promoting a
// fixture is now a one-line edit to `FIXTURE_METHOD_IDS`, and the shape of a
// fixture's answer can no longer drift between entries — there is only one
// shape.
//
// DATA-ONLY (ARCH-29, option (a)). A fixture is a methodId and a constant
// payload, read by code that already shipped. Nothing here loads, compiles or
// evaluates anything: no `import()`, no `Function`, no `vm`, no `eval`, no
// isolate binding — guard G2 of ARCH-29, enforced by the test beside this file.
// `createFixtureStrategy` is a plain closure over a string; the class it
// returns is this module's own code, not the payload's.
//
// PROVENANCE. Fixtures register through `registerMock()`, not `register()`
// (CH-24): `registry.catalogue()` reports them as `mock`, so the
// `labre://methods` resource tells a third-party harness the answer is a
// deterministic placeholder BEFORE it spends a call trusting it. That is the
// only thing that distinguishes a fixture from a real strategy on the wire, and
// it is why the boot no longer needs an env flag to hide them (see
// registry-boot.mts).
//
// REFUSAL. A fixture that must not run takes the kernel's single refusal
// channel — `static get disabled` read by `StrategyRegistry.register()`
// (ARCH-29 G2: one channel, not two). This module adds none of its own.

import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import { clockNow } from '#core/clock/run-clock-context.mjs';

/** What a fixture answers with. The Input side is deliberately open: a fixture
 *  ignores its input, and the real strategy that replaces it will declare its
 *  own narrow shape. This Result IS the I/O contract that successor must keep. */
export interface FixtureResult {
  mock: true;
  methodId: string;
}

/**
 * The catalogue's scaffold entries (ast-schema.md v0.1.0 § 1.2), sorted.
 *
 * TO PROMOTE a fixture to a real strategy: delete its line here and register
 * the real class in its framework's own registry. That single edit is also what
 * flips `labre://methods` from `mock` to `real`, so the catalogue cannot claim
 * an implementation the process does not hold.
 */
export const FIXTURE_METHOD_IDS: readonly string[] = [
  "common:toolbox:list:emit:default",
  "common:toolbox:wardley:json-boilerplate:default",
  "render:wardley-map:image:config:png",
  "render:wardley-map:image:config:svg",
  "render:wardley-map:owm:config:dsl",
  "wardley:climate:simon-wardley:inertia:inertia-analysis",
  "wardley:climate:simon-wardley:inertia:list",
  "wardley:climate:simon-wardley:list:kanban-view",
  "wardley:climate:simon-wardley:list:list-view",
  "wardley:climate:wiki:detail:wiki-url",
  "wardley:climate:wiki:list:kanban-view",
  "wardley:climate:wiki:list:list-view",
  "wardley:doctrine:simon-wardley:doctrinal-analysis:default",
  "wardley:doctrine:simon-wardley:doctrinal-analysis:phase-assessment",
  "wardley:doctrine:simon-wardley:doctrinal-analysis:three-judgement-assessment",
  "wardley:doctrine:simon-wardley:list:kanban-view",
  "wardley:doctrine:simon-wardley:list:kanban-view-group-by-phase",
  "wardley:doctrine:simon-wardley:list:list-view",
  "wardley:doctrine:simon-wardley:pst-analysis:organisation",
  "wardley:doctrine:simon-wardley:pst-analysis:personal",
  "wardley:doctrine:wiki:detail:wiki-url",
  "wardley:doctrine:wiki:doctrinal-analysis:default",
  "wardley:doctrine:wiki:list:kanban-view",
  "wardley:doctrine:wiki:list:phase-view",
  "wardley:gameplay:simon-wardley:list:list-view",
  "wardley:gameplay:wiki:detail:wiki-url",
  "wardley:gameplay:wiki:list:list-view",
  "wardley:iteration:act:next-step:default",
  "wardley:iteration:decide:next-step:default",
  "wardley:iteration:observe:next-step:default",
  "wardley:iteration:orient:next-step:default",
  "wardley:iteration:strategy-cycle:explain:default",
  "wardley:iteration:strategy-cycle:guide:default",
  "wardley:iteration:why-of-movement:guide:default",
  "wardley:iteration:why-of-purpose:guide:default",
  "wardley:map:climate:identify-method-issues:default",
  "wardley:map:climate:identify:default",
  "wardley:map:climate:inertia-identification:default",
  "wardley:map:config:x-axis:custom",
  "wardley:map:config:x-axis:standard",
  "wardley:map:config:y-axis:custom",
  "wardley:map:config:y-axis:standard",
  "wardley:map:doctrine:identify-the-method:default",
  "wardley:map:doctrine:orient-path-where-to-invest:default",
  "wardley:map:gameplay:recommend-strategy-over-the-map:default",
  "wardley:map:node:classify-point-of-change:default",
  "wardley:map:node:generate-node-from-pipeline:default",
  "wardley:map:node:generate-pipeline-from-component:default",
  "wardley:map:node:generate-pipeline:default",
  "wardley:map:node:identify-method:buy-policy",
  "wardley:map:node:identify-method:project-management",
  "wardley:map:node:identify-point-of-change:default",
  "wardley:map:output:read:where-to-invest",
  "wardley:map:output:update:default",
  "wardley:map:quality:audit:default",
  "wardley:map:value-chain:audit:default",
  "wardley:map:value-chain:generate:default",
  "wardley:map:value-chain:read:pipeline-opportunity",
  "wardley:map:zonage:generate:coherent-cluster",
  "wardley:map:zonage:generate:pst-analysis",
  "wardley:map:zonage:generate:teams",
];

/** A fixture's strategy class, as the registry consumes it: a no-arg
 *  constructor plus the static `method` every strategy declares. */
export type FixtureStrategyClass = (new () => BaseStrategy<
  Record<string, unknown>,
  FixtureResult
>) & { method: string };

/**
 * Build the strategy class for one fixture. One program, parameterised by the
 * only thing that differs between entries — the methodId.
 *
 * `capturedAt` comes from the RUN'S clock (`clockNow()`), never from a `new
 * Date()` of its own. This is the point of the migration: a replay with an
 * injected clock now reproduces a fixture's signal timestamp exactly, closing
 * the I3 hole that 61 private `new Date()` calls used to keep open.
 */
export function createFixtureStrategy(methodId: string): FixtureStrategyClass {
  return class FixtureStrategy extends BaseStrategy<Record<string, unknown>, FixtureResult> {
    static get method(): string {
      return methodId;
    }

    async evaluate(
      _input: Record<string, unknown>,
      _context: RequestContext,
    ): Promise<StrategyResult<FixtureResult>> {
      const capturedAt = clockNow().toISOString();
      return {
        signals: [{ name: 'mock', value: true, source: 'computed', capturedAt }],
        reasoning: [],
        insights: [{ text: `mock strategy for ${methodId}`, by: methodId, type: 'other' }],
        result: { mock: true, methodId },
      };
    }
  };
}

/** Register every fixture. Called by `buildStrategyRegistry()`. */
export function registerFixtures(registry: StrategyRegistry): void {
  for (const methodId of FIXTURE_METHOD_IDS) {
    registry.registerMock(methodId, createFixtureStrategy(methodId));
  }
}
