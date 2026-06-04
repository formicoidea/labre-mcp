import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { runCommand } from './recipe-runner.mjs';
import { OwmParserStrategy } from '#frameworks/wardley/chain/read/map/owm-parser-strategy.mjs';

const context: RequestContext = {
  projectId: 'test',
  projectRoot: '/tmp',
  sessionId: 's1',
  domain: 'render',
};

describe('runCommand', () => {
  it('runs a single real strategy and returns a populated envelope', async () => {
    const registry = new StrategyRegistry();
    registry.register(OwmParserStrategy.method, OwmParserStrategy);

    const outcome = await runCommand({
      command: 'render:wardley-map:owm:parse:dsl',
      input: { dsl: 'title Test\ncomponent Foo [0.5, 0.5]' },
      context,
      registry,
    });

    // The strategy's StrategyResult is written to $.result on the AST.
    const written = outcome.ast.result as { result: { title: string; componentCount: number } };
    assert.equal(typeof written.result.title, 'string');
    assert.ok(written.result.componentCount >= 1);

    // The envelope is assembled from the strategy's signals/insights + a trace entry.
    assert.ok(outcome.envelope.signals.length >= 1);
    assert.equal(outcome.envelope.trace.length, 1);
    assert.equal(outcome.envelope.trace[0].command, 'render:wardley-map:owm:parse:dsl');

    // The run emits a run-end event (drives artefact persistence in production).
    assert.ok(outcome.events.some((e) => e.phase === 'run-end'));
  });

  it('rejects an unknown methodId', async () => {
    const registry = new StrategyRegistry();
    await assert.rejects(() =>
      runCommand({
        command: 'render:wardley-map:owm:parse:dsl',
        input: { dsl: 'x' },
        context,
        registry,
      }),
    );
  });
});
