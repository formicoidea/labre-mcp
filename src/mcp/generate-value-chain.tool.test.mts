// Wiring tests for the `generateValueChain` tool (roadmap B3).
//
// NO REAL LLM CALL. The shipped generate recipe starts with
// `value-chain:generate:top-down` (two LLM calls), so the end-to-end wiring is
// exercised against a project-root OVERRIDE recipe that keeps only the
// deterministic emit step. What that override still proves is exactly the part
// this tool owns: the natural-language input is projected onto the canonical
// basemap WardleyMap the shipped recipe's first step consumes, and the emitted
// DSL is lifted out of `$.output`. The shipped recipe is asserted structurally.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import '#lib/prompts/init.mjs';
import { GENERATE_VALUE_CHAIN_TOOL } from './generate-value-chain.tool.mjs';
import { GenerateValueChainInputSchema } from '#schemas/generate-value-chain.schema.mjs';
import { SHIPPED_ROOT } from './shipped-root.mjs';
import type { GenerateValueChainViaRecipeResult } from './generate-value-chain-via-recipe.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

// Same domain/tool/name as the shipped recipe so loadRecipe picks it up from
// the project root; the LLM generation + layout steps are dropped and the
// basemap is emitted straight back as DSL.
const EMIT_ONLY_RECIPE = {
  schemaVersion: '1.0',
  name: 'generate',
  domain: 'wardley',
  tool: 'map',
  description: 'TEST recipe — emit only (deterministic, no LLM) for wiring validation',
  steps: [
    {
      stepId: 'emit',
      tool: 'render:wardley-map:owm:emit:dsl',
      in: '$.input',
      out: '$.output',
    },
  ],
  listeners: {},
};

async function setupProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'labre-generate-vc-'));
  const recipeDir = join(projectRoot, 'recipes', 'wardley', 'map');
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    join(recipeDir, 'generate.recipe.json'),
    JSON.stringify(EMIT_ONLY_RECIPE),
    'utf8',
  );
  return projectRoot;
}

describe('generateValueChain tool — surface', () => {
  it('advertises the tool name and a JSON Schema requiring `prompt`', () => {
    assert.equal(GENERATE_VALUE_CHAIN_TOOL.name, 'generateValueChain');
    const schema = GENERATE_VALUE_CHAIN_TOOL.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.prompt, 'prompt is advertised');
    assert.ok(schema.properties.context, 'context is advertised');
    assert.deepEqual(schema.required, ['prompt'], 'context stays optional');
  });

  it('rejects input without a non-empty prompt', () => {
    assert.throws(() => GenerateValueChainInputSchema.parse({}));
    assert.throws(() => GenerateValueChainInputSchema.parse({ prompt: '' }));
    // .strict() — an unknown key is a caller mistake, not silently dropped.
    assert.throws(() =>
      GenerateValueChainInputSchema.parse({ prompt: 'Tea shop', description: 'nope' }),
    );
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
    await assert.rejects(GENERATE_VALUE_CHAIN_TOOL.handler({ prompt: 42 }, context));
  });
});

describe('generateValueChain tool — shipped recipe contract', () => {
  it('starts on $.input with the top-down generator and ends on an OWM emit', async () => {
    const shipped = JSON.parse(
      await readFile(
        join(SHIPPED_ROOT, 'recipes', 'wardley', 'map', 'generate.recipe.json'),
        'utf8',
      ),
    ) as { steps: Array<{ stepId: string; tool: string; in?: string; out?: string }> };

    const first = shipped.steps[0];
    assert.equal(first.tool, 'wardley:map:value-chain:generate:top-down');
    assert.equal(first.in, '$.input', 'the basemap projection targets this step');

    const last = shipped.steps[shipped.steps.length - 1];
    assert.equal(last.tool, 'render:wardley-map:owm:emit:dsl');
    assert.equal(last.out, '$.output', 'the emitted dsl is lifted from here');
  });
});

describe('generateValueChain tool — end-to-end wiring (no LLM)', () => {
  it('projects the prompt onto a basemap, runs the recipe and writes an artefact', async () => {
    const projectRoot = await setupProjectRoot();
    const artifactDir = join(projectRoot, '.artifacts');
    await mkdir(artifactDir, { recursive: true });
    const sessionId = randomUUID();

    const out = (await GENERATE_VALUE_CHAIN_TOOL.handler(
      { prompt: 'Map the value chain of an online tea shop', context: 'UK retail, 2026' },
      { projectId: 'b3-test', projectRoot, sessionId, domain: 'wardley', artifactDir },
    )) as GenerateValueChainViaRecipeResult;

    assert.ok(out.recipeRunId.length > 0);

    // The natural-language pair became the canonical basemap the shipped
    // recipe's first step consumes: prompt → title, context → context.
    const input = out.ast.input as {
      title: string;
      context?: string;
      components: unknown[];
      relations: unknown[];
    };
    assert.equal(input.title, 'Map the value chain of an online tea shop');
    assert.equal(input.context, 'UK retail, 2026');
    assert.deepEqual(input.components, []);
    assert.deepEqual(input.relations, []);

    // The emitted DSL is lifted out of `$.output`.
    assert.equal(typeof out.dsl, 'string');
    assert.match(out.dsl as string, /Map the value chain of an online tea shop/);

    assert.equal(out.envelope.trace.length, 1);
    assert.equal(out.envelope.trace[0].command, 'render:wardley-map:owm:emit:dsl');

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

  it('omits `context` from the basemap when the caller did not supply one', async () => {
    const projectRoot = await setupProjectRoot();
    const artifactDir = join(projectRoot, '.artifacts');
    await mkdir(artifactDir, { recursive: true });

    const out = (await GENERATE_VALUE_CHAIN_TOOL.handler({ prompt: 'Tea shop' }, {
      projectId: 'b3-test',
      projectRoot,
      sessionId: randomUUID(),
      domain: 'wardley',
      artifactDir,
    })) as GenerateValueChainViaRecipeResult;

    const input = out.ast.input as { title: string; context?: string };
    assert.equal(input.title, 'Tea shop');
    assert.equal(input.context, undefined);
  });
});
