import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
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
  envelope?: { insights: unknown[]; trace: unknown[] };
  errors?: string[];
}

describe('runRecipe tool', () => {
  it('runs a shipped recipe by name and returns its envelope', async () => {
    const out = (await RUN_RECIPE_TOOL.handler(
      {
        recipe: 'wardley:map:position-chain-in-evolution',
        input: { wardley: { map: { components: [] } } },
      },
      context,
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'ok');
    assert.equal(out.recipe, 'wardley:map:position-chain-in-evolution');
    assert.ok(out.recipeRunId, 'recipeRunId should be present');
    // Two steps (position, render-svg) each leave a trace entry; mock strategies
    // and the pipeline-opportunity listener contribute insights.
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
});
