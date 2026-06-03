import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectId, initProjectMarker, resetProjectIdCache } from "./project-id-resolver.mjs";
import { writeArtifact, defaultArtifactDir } from "./artifact-writer.mjs";
import { attachArtifactWriter } from "../listeners/artifact-writer-listener.mjs";
import { createEventBus } from "../bus/event-bus.mjs";
import type { RequestContext } from "../context/request-context.mjs";
import type { PipelineEvent } from "../bus/event.schema.mjs";

function buildContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    projectId: "test-project",
    projectRoot: "/tmp/test",
    sessionId: "s1",
    domain: "wardley",
    ...overrides,
  };
}

describe("resolveProjectId", () => {
  beforeEach(() => resetProjectIdCache());

  it("reads projectId from .labre/project.json when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "labre-pid-"));
    await mkdir(join(root, ".labre"), { recursive: true });
    await writeFile(
      join(root, ".labre", "project.json"),
      JSON.stringify({ projectId: "explicit-uuid-1234" }),
      "utf8",
    );
    const id = await resolveProjectId(root);
    assert.equal(id, "explicit-uuid-1234");
  });

  it("falls back to deterministic SHA-1 hash of absolute path when no marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "labre-pid-"));
    const id1 = await resolveProjectId(root);
    resetProjectIdCache();
    const id2 = await resolveProjectId(root);
    assert.equal(id1, id2);
    assert.equal(id1.length, 16); // 16 hex chars
    assert.match(id1, /^[0-9a-f]{16}$/);
  });

  it("initProjectMarker writes the marker and seeds the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "labre-pid-"));
    await initProjectMarker(root, "my-uuid");
    const id = await resolveProjectId(root);
    assert.equal(id, "my-uuid");

    // File on disk should be readable too
    const raw = await readFile(join(root, ".labre", "project.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), { projectId: "my-uuid" });
  });
});

describe("writeArtifact", () => {
  it("writes a JSON artefact at artifactDir/<runId>.json", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "labre-art-"));
    const context = buildContext({ artifactDir: tmpDir });
    const events: PipelineEvent[] = [
      {
        schemaVersion: "1.0",
        recipeRunId: "run-123",
        stepId: "s1",
        methodId: "wardley:map:value-chain:generate:top-down",
        phase: "step-end",
        timestamp: "2026-05-10T14:23:00Z",
      },
    ];

    const path = await writeArtifact({
      context,
      events,
      ast: { schemaVersion: "1.0", title: "Test" },
      startedAt: "2026-05-10T14:22:00Z",
      completedAt: "2026-05-10T14:24:00Z",
      recipeRunId: "run-123",
    });

    assert.ok(path.endsWith("run-123.json"));
    const body = JSON.parse(await readFile(path, "utf8"));
    assert.equal(body.recipeRunId, "run-123");
    assert.equal(body.projectId, "test-project");
    assert.equal(body.events.length, 1);
    assert.deepEqual(body.ast, { schemaVersion: "1.0", title: "Test" });
  });

  it("defaultArtifactDir uses homedir-relative ~/.labre-mcp/runs/<projectId>/", () => {
    const dir = defaultArtifactDir("abc123");
    assert.ok(dir.endsWith(join(".labre-mcp", "runs", "abc123")));
  });
});

describe("attachArtifactWriter (core listener)", () => {
  it("writes an artefact on run-end with the captured event trace + AST", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "labre-art-listener-"));
    const context = buildContext({ artifactDir: tmpDir });
    const bus = createEventBus();
    let ast: Record<string, unknown> = { schemaVersion: "1.0", value: "initial" };

    const handle = attachArtifactWriter({
      bus,
      context,
      getAst: () => ast,
    });

    bus.emit({
      schemaVersion: "1.0",
      recipeRunId: "run-end-test",
      stepId: "step1",
      methodId: "wardley:map:value-chain:generate:top-down",
      phase: "step-end",
      timestamp: "2026-05-10T14:23:00Z",
    });

    ast = { schemaVersion: "1.0", value: "after-mutation" };

    bus.emit({
      schemaVersion: "1.0",
      recipeRunId: "run-end-test",
      stepId: "__run__",
      methodId: "wardley:chain:recipe:test",
      phase: "run-end",
      timestamp: "2026-05-10T14:25:00Z",
    });

    const path = await handle.artifactPath;
    assert.ok(path !== null);

    const body = JSON.parse(await readFile(path as string, "utf8"));
    assert.equal(body.recipeRunId, "run-end-test");
    assert.equal(body.events.length, 2);
    // The AST captured should reflect mutations up to run-end.
    assert.equal((body.ast as { value: string }).value, "after-mutation");

    await handle.detach();
  });
});
