import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { RUN_RECIPE_TOOL } from './run-recipe.tool.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

// Artefacts go to a temp dir so the test never touches ~/.labre-mcp.
const context: RequestContext = {
  projectId: 'test',
  projectRoot: process.cwd(),
  sessionId: 's1',
  domain: 'wardley',
  artifactDir: path.join(os.tmpdir(), 'labre-run-recipe-test'),
};

// The handler returns a bare RunRecipeResult (the daemon dispatch wraps it in
// Degradable<T>; calling the handler directly bypasses that wrapping).
interface RunRecipeResultShape {
  recipe: string;
  status: string;
  recipeRunId?: string;
  artifactPath?: string | null;
  envelope?: { insights: unknown[]; trace: unknown[] };
  errors?: string[];
}

describe('runRecipe tool', () => {
  it('runs a shipped recipe by name and returns its envelope', async () => {
    const out = (await RUN_RECIPE_TOOL.handler(
      {
        recipe: 'wardley:map:estimate-chain-components',
        input: { title: 'empty', components: [], relations: [] },
      },
      context,
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'ok');
    assert.equal(out.recipe, 'wardley:map:estimate-chain-components');
    assert.ok(out.recipeRunId, 'recipeRunId should be present');
    // Two steps (select, estimate-all) each leave a trace entry; the selector
    // contributes a "selected N/M" insight. Empty map → 0 components selected,
    // so estimate-all fans out over an empty array (no LLM call).
    assert.ok((out.envelope?.trace.length ?? 0) >= 2);
    assert.ok((out.envelope?.insights.length ?? 0) >= 1);
  });

  it('returns status:error for an unknown recipe', async () => {
    const out = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:does-not-exist', input: {} },
      context,
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'error');
    assert.ok((out.errors?.length ?? 0) >= 1);
  });

  it('returns an artefact path for a recipe that fails during execution', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'labre-failing-recipe-'));
    const recipeDir = path.join(projectRoot, 'recipes', 'wardley', 'map');
    const artifactDir = path.join(projectRoot, '.artifacts');
    await mkdir(recipeDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(recipeDir, 'failing.recipe.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        name: 'failing',
        domain: 'wardley',
        tool: 'map',
        steps: [
          {
            stepId: 'missing-strategy',
            tool: 'wardley:map:value-chain:generate:not-registered',
            in: '$.input',
            out: '$.result',
          },
        ],
        listeners: {},
      }),
      'utf8',
    );

    const out = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:failing', input: { title: 'boom' } },
      { ...context, projectRoot, artifactDir },
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'error');
    assert.ok(out.artifactPath, 'artifactPath should be present for execution failures');
    const artifact = JSON.parse(await readFile(out.artifactPath as string, 'utf8')) as {
      events: Array<{ phase: string }>;
      ast: { input?: unknown };
    };
    assert.deepEqual(artifact.ast.input, { title: 'boom' });
    assert.ok(artifact.events.some((event) => event.phase === 'run-end'));
  });
});
