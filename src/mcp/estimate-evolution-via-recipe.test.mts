// End-to-end wiring test for the recipe-based estimateEvolution handler.
// Avoids LLM calls by overriding the canonical recipe in a temp project
// root with one that uses only `s-curve` (deterministic math).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import '#lib/prompts/init.mjs';
import { handleEstimateEvolutionViaRecipe } from './estimate-evolution-via-recipe.mjs';

const SCURVE_RECIPE = {
  schemaVersion: '1.0',
  name: 'estimate-component-evolution',
  domain: 'wardley',
  tool: 'map',
  description: 'TEST recipe — uses s-curve (deterministic, no LLM) for wiring validation',
  steps: [
    {
      stepId: 'estimate',
      tool: 'wardley:map:climate:position-functional-in-evolution:s-curve',
      in: '$.input',
      out: '$.estimate',
    },
  ],
  listeners: [],
};

async function setupProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'labre-m12-'));
  // Write the override recipe to <projectRoot>/recipes/wardley/map/
  const recipeDir = join(projectRoot, 'recipes', 'wardley', 'map');
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    join(recipeDir, 'estimate-component-evolution.recipe.json'),
    JSON.stringify(SCURVE_RECIPE),
    'utf8',
  );
  return projectRoot;
}

describe('handleEstimateEvolutionViaRecipe — end-to-end wiring', () => {
  it('runs the recipe runner end-to-end and writes an artefact', async () => {
    const projectRoot = await setupProjectRoot();
    const artifactDir = join(projectRoot, '.artifacts');
    await mkdir(artifactDir, { recursive: true });

    const sessionId = randomUUID();

    const result = await handleEstimateEvolutionViaRecipe({
      name: 'CRM',
      certitude: 0.85,
      ubiquity: 0.6,
      _context: {
        projectId: 'm12-test',
        projectRoot,
        sessionId,
        domain: 'wardley',
        artifactDir,
      },
    });

    // The recipe ran — recipeRunId is set
    assert.ok(result.recipeRunId.length > 0);

    // AST has the estimate output at $.estimate (per recipe step.out)
    const estimate = result.ast.estimate as {
      result: { evolution: number; confidence: number; method: string };
      signals: Array<{ name: string }>;
    };
    assert.ok(estimate.result);
    assert.equal(estimate.result.method, 'wardley:map:climate:position-functional-in-evolution:s-curve');
    assert.ok(estimate.result.evolution >= 0 && estimate.result.evolution <= 1);
    assert.ok(estimate.signals.length >= 2, 'certitude + ubiquity captured as signals');

    // Events captured step-start, step-end, run-end
    const phases = result.events.map((e) => (e as { phase: string }).phase);
    assert.ok(phases.includes('step-start'));
    assert.ok(phases.includes('step-end'));
    assert.ok(phases.includes('run-end'));

    // CP9: JSON-labre envelope aggregated from StrategyResults
    assert.ok(result.envelope, 'envelope returned alongside ast');
    assert.ok(Array.isArray(result.envelope.signals));
    assert.ok(result.envelope.signals.length >= 2, 'aggregated signals from s-curve step');
    assert.ok(Array.isArray(result.envelope.trace));
    assert.equal(result.envelope.trace.length, 1, 'one trace entry per step');
    assert.equal(result.envelope.trace[0].command, 'wardley:map:climate:position-functional-in-evolution:s-curve');

    // Artefact was written
    assert.ok(result.artifactPath !== null, 'artifact path returned');
    const artifactJson = JSON.parse(await readFile(result.artifactPath as string, 'utf8'));
    assert.equal(artifactJson.recipeRunId, result.recipeRunId);
    assert.equal(artifactJson.sessionId, sessionId);
    assert.equal(artifactJson.projectId, 'm12-test');
    assert.ok(Array.isArray(artifactJson.events));
    assert.ok(artifactJson.events.length >= 3);
    assert.equal(
      (artifactJson.ast.estimate.result as { method: string }).method,
      'wardley:map:climate:position-functional-in-evolution:s-curve',
    );
  });

  it('rejects invalid input via Zod', async () => {
    const projectRoot = await setupProjectRoot();
    await assert.rejects(
      handleEstimateEvolutionViaRecipe({
        // Missing 'name' (required)
        certitude: 0.5,
        _context: {
          projectId: 'p',
          projectRoot,
          sessionId: 's',
          domain: 'wardley',
        },
      }),
    );
  });
});
