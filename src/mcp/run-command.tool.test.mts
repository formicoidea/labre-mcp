import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { RUN_COMMAND_TOOL } from './run-command.tool.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

// Artefacts go to a temp dir so the test never touches ~/.labre-mcp.
const context: RequestContext = {
  projectId: 'test',
  projectRoot: process.cwd(),
  sessionId: 's1',
  domain: 'render',
  artifactDir: path.join(os.tmpdir(), 'labre-run-command-test'),
};

interface WrappedResult {
  degraded: boolean;
  result: {
    command: string;
    status: string;
    output: unknown;
    envelope?: { signals: unknown[]; trace: unknown[] };
    errors?: string[];
    metadata?: { recipeRunId?: string };
  };
}

describe('runCommand tool', () => {
  it('returns an ok CommandResult with envelope for a real command', async () => {
    const out = (await RUN_COMMAND_TOOL.handler(
      { command: 'render:wardley-map:owm:parse:dsl', input: { dsl: 'title T\ncomponent A [0.4, 0.4]' } },
      context,
    )) as WrappedResult;

    assert.equal(out.degraded, false);
    assert.equal(out.result.status, 'ok');
    assert.equal(out.result.command, 'render:wardley-map:owm:parse:dsl');
    assert.equal(out.result.envelope?.trace.length, 1);
    assert.ok(out.result.metadata?.recipeRunId);
  });

  it('returns a status:error CommandResult for an unknown methodId', async () => {
    const out = (await RUN_COMMAND_TOOL.handler(
      { command: 'wardley:map:nope:identify:default', input: {} },
      context,
    )) as WrappedResult;

    assert.equal(out.result.status, 'error');
    assert.ok((out.result.errors?.length ?? 0) >= 1);
  });
});
