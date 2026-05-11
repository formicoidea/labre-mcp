// Artifact writer: persists a recipe execution trace to a JSON file
// (ARCH-12). The format is verbose and LLM-readable: descriptive keys, no
// compression, no abbreviation. Future analytical layers (V2 DuckDB) read
// these files directly.
//
// Default location: ~/.labre-mcp/runs/<projectId>/<runId>.json
// Override via RequestContext.artifactDir for project-local benchmarks.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { PipelineEvent } from "../bus/event.schema.mjs";
import type { RequestContext } from "../context/request-context.mjs";

export interface ArtifactBody {
  schemaVersion: "1.0";
  recipeRunId: string;
  sessionId: string;
  domain: string;
  projectId: string;
  projectRoot: string;
  startedAt: string;
  completedAt: string;
  events: PipelineEvent[];
  // any: ast is open-shape — depends on which tool produced it
  ast: unknown;
}

export function defaultArtifactDir(projectId: string): string {
  return join(homedir(), ".labre-mcp", "runs", projectId);
}

export interface WriteArtifactOptions {
  context: RequestContext;
  events: PipelineEvent[];
  ast: unknown;
  startedAt: string;
  completedAt: string;
  recipeRunId: string;
}

export async function writeArtifact(options: WriteArtifactOptions): Promise<string> {
  const { context, events, ast, startedAt, completedAt, recipeRunId } = options;

  const targetDir = context.artifactDir
    ? resolve(context.artifactDir)
    : defaultArtifactDir(context.projectId);

  await mkdir(targetDir, { recursive: true });

  const body: ArtifactBody = {
    schemaVersion: "1.0",
    recipeRunId,
    sessionId: context.sessionId,
    domain: context.domain,
    projectId: context.projectId,
    projectRoot: context.projectRoot,
    startedAt,
    completedAt,
    events,
    ast,
  };

  const targetPath = join(targetDir, `${recipeRunId}.json`);
  await writeFile(targetPath, JSON.stringify(body, null, 2), "utf8");
  return targetPath;
}
