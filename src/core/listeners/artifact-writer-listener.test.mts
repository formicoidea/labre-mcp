import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../bus/event-bus.mjs';
import type { PipelineEvent } from '../bus/event.schema.mjs';
import type { RequestContext } from '../context/request-context.mjs';
import { attachArtifactWriter, type WriteArtifactFn } from './artifact-writer-listener.mjs';

const ctx: RequestContext = {
  projectId: 'test-project',
  projectRoot: '/tmp/test',
  sessionId: 'test-session',
  domain: 'wardley',
};

function runEndEvent(): PipelineEvent {
  return {
    schemaVersion: '1.0',
    recipeRunId: 'run-1',
    stepId: 'final',
    methodId: 'test:tool:write:subdomain:strategy',
    phase: 'run-end',
    timestamp: new Date().toISOString(),
  };
}

describe('attachArtifactWriter — timeout', () => {
  it('resolves artifactPath to null when writeArtifact hangs past the timeout', async () => {
    const bus = createEventBus();
    const hungWriter: WriteArtifactFn = () => new Promise<string>(() => {
      // Never resolves — simulates a stalled disk.
    });

    const handle = attachArtifactWriter({
      bus,
      context: ctx,
      getAst: () => ({ schemaVersion: '1.0' }),
      writeArtifact: hungWriter,
      timeoutMs: 50,
    });

    bus.emit(runEndEvent());
    const path = await handle.artifactPath;
    assert.equal(path, null);
  });

  it('resolves to the artefact path when writeArtifact completes within the timeout', async () => {
    const bus = createEventBus();
    const fakePath = '/tmp/test/run-1.json';
    const okWriter: WriteArtifactFn = async () => fakePath;

    const handle = attachArtifactWriter({
      bus,
      context: ctx,
      getAst: () => ({ schemaVersion: '1.0' }),
      writeArtifact: okWriter,
      timeoutMs: 1000,
    });

    bus.emit(runEndEvent());
    const path = await handle.artifactPath;
    assert.equal(path, fakePath);
  });

  it('resolves to null when writeArtifact rejects', async () => {
    const bus = createEventBus();
    const failingWriter: WriteArtifactFn = async () => {
      throw new Error('disk full');
    };

    const handle = attachArtifactWriter({
      bus,
      context: ctx,
      getAst: () => ({ schemaVersion: '1.0' }),
      writeArtifact: failingWriter,
      timeoutMs: 1000,
    });

    bus.emit(runEndEvent());
    const path = await handle.artifactPath;
    assert.equal(path, null);
  });
});
