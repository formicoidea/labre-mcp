// Wiring tests for the `evaluateMap` tool (roadmap B3).
//
// NO REAL LLM CALL. The shipped evaluate-map recipe fans out over
// `llm-direct` + `node:identify`, both LLM-backed, so the end-to-end wiring is
// exercised against a project-root OVERRIDE recipe that keeps the same
// deterministic parse step and drops the LLM fan-out. The shipped recipe
// itself is asserted structurally (its `over` path is a known regression).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import '#lib/prompts/init.mjs';
import { EVALUATE_MAP_TOOL } from './evaluate-map.tool.mjs';
import { EvaluateMapInputSchema } from '#schemas/evaluate-map.schema.mjs';
import { SHIPPED_ROOT } from '#core/shipped-root.mjs';
import type { EvaluateMapViaRecipeResult } from './evaluate-map-via-recipe.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const DSL = 'title Tea Shop\nanchor Business [0.9, 0.6]\ncomponent Cup of Tea [0.8, 0.6]\n';

// Same domain/tool/name as the shipped recipe so loadRecipe picks it up from
// the project root; only the deterministic parse step is kept.
const PARSE_ONLY_RECIPE = {
  schemaVersion: '1.0',
  name: 'evaluate-map',
  domain: 'wardley',
  tool: 'map',
  description: 'TEST recipe — parse only (deterministic, no LLM) for wiring validation',
  steps: [
    {
      stepId: 'parse-map',
      tool: 'render:wardley-map:owm:parse:dsl',
      in: '$.input',
      out: '$.chain',
    },
  ],
  listeners: {},
};

async function setupProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'labre-evaluate-map-'));
  const recipeDir = join(projectRoot, 'recipes', 'wardley', 'map');
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    join(recipeDir, 'evaluate-map.recipe.json'),
    JSON.stringify(PARSE_ONLY_RECIPE),
    'utf8',
  );
  return projectRoot;
}

describe('evaluateMap tool — surface', () => {
  it('advertises the tool name and a JSON Schema requiring `dsl`', () => {
    assert.equal(EVALUATE_MAP_TOOL.name, 'evaluateMap');
    const schema = EVALUATE_MAP_TOOL.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.dsl, 'dsl is advertised');
    assert.deepEqual(schema.required, ['dsl']);
  });

  it('rejects input that is not a non-empty dsl string', () => {
    assert.throws(() => EvaluateMapInputSchema.parse({}));
    assert.throws(() => EvaluateMapInputSchema.parse({ dsl: '' }));
    // .strict() — an unknown key is a caller mistake, not silently dropped.
    assert.throws(() => EvaluateMapInputSchema.parse({ dsl: 'title T', filePath: '/tmp/a.wm' }));
  });

  it('rejects invalid arguments through the handler (no recipe run)', async () => {
    const projectRoot = await setupProjectRoot();
    const context: RequestContext = {
      projectId: 'b3-test',
      projectRoot,
      sessionId: 's1',
      domain: 'wardley',
      artifactDir: join(projectRoot, '.artifacts'),
    };
    await assert.rejects(EVALUATE_MAP_TOOL.handler({ dsl: 42 }, context));
  });
});

describe('evaluateMap tool — shipped recipe contract', () => {
  it('fans out over $.chain.result.map.components (regression: corrected path)', async () => {
    const shipped = JSON.parse(
      await readFile(
        join(SHIPPED_ROOT, 'recipes', 'wardley', 'map', 'evaluate-map.recipe.json'),
        'utf8',
      ),
    ) as { steps: Array<{ stepId: string; tool: string; in?: string; over?: string }> };

    const parse = shipped.steps.find((s) => s.stepId === 'parse-map');
    assert.equal(parse?.tool, 'render:wardley-map:owm:parse:dsl');
    assert.equal(parse?.in, '$.input', 'the tool input schema mirrors this step');

    for (const stepId of ['estimate-all', 'identify-all']) {
      const step = shipped.steps.find((s) => s.stepId === stepId);
      assert.equal(step?.over, '$.chain.result.map.components', `${stepId} fan-out path`);
    }
  });
});

describe('evaluateMap tool — end-to-end wiring (no LLM)', () => {
  it('runs the recipe runner, returns the envelope and writes an artefact', async () => {
    const projectRoot = await setupProjectRoot();
    const artifactDir = join(projectRoot, '.artifacts');
    await mkdir(artifactDir, { recursive: true });
    const sessionId = randomUUID();

    const out = (await EVALUATE_MAP_TOOL.handler({ dsl: DSL }, {
      projectId: 'b3-test',
      projectRoot,
      sessionId,
      domain: 'wardley',
      artifactDir,
    })) as EvaluateMapViaRecipeResult;

    assert.ok(out.recipeRunId.length > 0);

    // `$.input` is the validated `{ dsl }` the parse step consumes verbatim.
    assert.deepEqual(out.ast.input, { dsl: DSL });

    // The parse step landed at `$.chain` — the fan-out source in the shipped recipe.
    const chain = out.ast.chain as {
      result: { parsed: boolean; map: { components: Array<{ label: { name: string } }> } };
    };
    assert.equal(chain.result.parsed, true);
    assert.equal(chain.result.map.components.length, 2, 'anchor + component parsed');

    assert.equal(out.envelope.trace.length, 1);
    assert.equal(out.envelope.trace[0].command, 'render:wardley-map:owm:parse:dsl');

    const phases = out.events.map((e) => (e as { phase: string }).phase);
    assert.ok(phases.includes('step-start'));
    assert.ok(phases.includes('run-end'));

    assert.ok(out.artifactPath, 'artefact path returned');
    const artifact = JSON.parse(await readFile(out.artifactPath as string, 'utf8')) as {
      recipeRunId: string;
      sessionId: string;
    };
    assert.equal(artifact.recipeRunId, out.recipeRunId);
    assert.equal(artifact.sessionId, sessionId);
  });
});
