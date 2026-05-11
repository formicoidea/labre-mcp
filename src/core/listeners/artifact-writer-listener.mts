// Core listener (ARCH-10, non-disablable) that persists each recipe run's
// trace + final AST as a JSON artefact. Subscribed to the event bus at
// recipe-runner start; writes on the `run-end` event.
//
// V1 cannot be disabled by user config (ARCH-08 / ARCH-10). It can be
// silenced for in-process tests by not attaching it — production paths
// always attach via attachArtifactWriter().
//
// Timeout: writeArtifact is bounded by ARTIFACT_WRITE_TIMEOUT_MS (default
// 30 s). On timeout, the promise resolves to `null` so callers awaiting
// `artifactPath` cannot hang on a stalled disk (NFS, slow filesystem).

import type { EventBus } from "../bus/event-bus.mjs";
import type { PipelineEvent } from "../bus/event.schema.mjs";
import type { RequestContext } from "../context/request-context.mjs";
import {
  writeArtifact as defaultWriteArtifact,
  type WriteArtifactOptions,
} from "../persistence/artifact-writer.mjs";

export const ARTIFACT_WRITE_TIMEOUT_MS = 30_000;

export type WriteArtifactFn = (args: WriteArtifactOptions) => Promise<string>;

export interface AttachArtifactWriterOptions {
  bus: EventBus;
  context: RequestContext;
  // any: AST is open-shape — depends on which tool produced it
  getAst: () => unknown;
  // Injection seam for tests; production callers omit it and get the real writer.
  writeArtifact?: WriteArtifactFn;
  // Override for tests that want to assert timeout behaviour quickly.
  timeoutMs?: number;
}

export interface ArtifactWriterHandle {
  /** Force-detach and flush any pending writes (idempotent). */
  detach(): Promise<void>;
  /** Path of the written artefact (resolved after run-end event fires, or `null` on failure / timeout). */
  artifactPath: Promise<string | null>;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function attachArtifactWriter(options: AttachArtifactWriterOptions): ArtifactWriterHandle {
  const events: PipelineEvent[] = [];
  const startedAt = new Date().toISOString();
  const writeFn: WriteArtifactFn = options.writeArtifact ?? defaultWriteArtifact;
  const timeoutMs = options.timeoutMs ?? ARTIFACT_WRITE_TIMEOUT_MS;

  let resolveArtifactPath: (p: string | null) => void;
  const artifactPath = new Promise<string | null>((r) => {
    resolveArtifactPath = r;
  });

  const subscription = options.bus.observe().subscribe(async (event) => {
    events.push(event);
    if (event.phase === "run-end") {
      const result = await withTimeout(
        writeFn({
          context: options.context,
          events: [...events],
          ast: options.getAst(),
          startedAt,
          completedAt: event.timestamp,
          recipeRunId: event.recipeRunId,
        }),
        timeoutMs,
        () => {
          // Persistence stall must never abort a recipe — fail open. The
          // null resolution below signals "no artefact path available" to
          // the caller.
        },
      );
      resolveArtifactPath(result);
    }
  });

  return {
    async detach() {
      subscription.unsubscribe();
      resolveArtifactPath(null);
    },
    artifactPath,
  };
}
