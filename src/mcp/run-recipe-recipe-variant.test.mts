// E2E-style test for recipe-experiment variant assignment (A/B testing of
// whole recipes) — the symmetric counterpart to prompt-experiment variants.
//
// Proves the runRecipe tool, when PostHog assigns a recipe variant:
//   1. loads and runs the VARIANT recipe instead of the requested one (both
//      resolved through the same loadRecipe path — a variant is just another
//      recipe of the same domain+tool);
//   2. attributes the run to $feature/mcp-recipe-<ref> = the SERVED variant on
//      mcp_run_end;
//   3. fails OPEN: a variant naming a recipe that does not resolve runs the
//      REQUESTED recipe, with no recipe attribution (never credits a variant
//      that didn't run).
//
// All-fake, zero network: the LLM is stubbed and PostHog is a recording fake.
// Two user recipes distinguished by their output key (result vs resultB) prove
// which recipe actually ran.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { RUN_RECIPE_TOOL } from './run-recipe.tool.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { resetRecipeCache } from '#core/recipe/recipe-loader.mjs';
import { setPostHogFlags } from '#lib/flags/state.mjs';
import type { PostHogFlags, RecipeRef } from '#lib/flags/posthog.mjs';
import { setLLMCallForTesting, resetLLMRegistryCache } from '#lib/llm/registry.mjs';
import { resetPromptRegistryCache } from '#lib/prompts/registry.mjs';
import { resetPromptsConfigCache } from '#lib/prompts/config.loader.mjs';
import '#lib/prompts/init.mjs';

interface RunRecipeResultShape {
  recipe: string;
  status: string;
  ast?: Record<string, unknown>;
  errors?: string[];
}

const CANNED_RESPONSE = [
  'type=component',
  'nature=activity',
  'capability=Manage customer relationships',
  'confidence=0.90',
  'justification=stub',
].join('\n');

// A recording fake PostHogFlags: gate allows, no prompt variants, and a
// scripted recipe-variant verdict. Records captures for attribution assertions.
function buildRecipeVariantFlags(
  recipeVariant: string | undefined,
): PostHogFlags & {
  captured: Array<{ event: string; distinctId: string; properties?: Record<string, unknown> }>;
} {
  const captured: Array<{
    event: string;
    distinctId: string;
    properties?: Record<string, unknown>;
  }> = [];
  return {
    captured,
    async isRecipeEnabled() {
      return true;
    },
    async resolveRecipeVariant(_ref: RecipeRef) {
      return recipeVariant;
    },
    async resolvePromptVariants() {
      return {};
    },
    capture(event, distinctId, properties) {
      captured.push({ event, distinctId, properties });
    },
    async shutdown() {},
  };
}

// A projectRoot carrying the requested recipe (out: $.result) and a variant
// recipe (out: $.resultB). Same single identify step; the differing output key
// is the tell for which recipe actually ran.
async function writeRecipes(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'labre-recipe-variant-'));
  const recipeDir = path.join(projectRoot, 'recipes', 'wardley', 'map');
  await mkdir(recipeDir, { recursive: true });
  const recipe = (name: string, out: string) => ({
    schemaVersion: '1.0',
    name,
    domain: 'wardley',
    tool: 'map',
    steps: [{ stepId: 'identify', tool: 'wardley:map:node:identify:default', in: '$.input', out }],
    listeners: {},
  });
  await writeFile(
    path.join(recipeDir, 'base-identify.recipe.json'),
    JSON.stringify(recipe('base-identify', '$.result')),
    'utf8',
  );
  await writeFile(
    path.join(recipeDir, 'base-identify-b.recipe.json'),
    JSON.stringify(recipe('base-identify-b', '$.resultB')),
    'utf8',
  );
  return projectRoot;
}

function makeContext(projectRoot: string): RequestContext {
  return {
    projectId: 'test',
    projectRoot,
    sessionId: 's-recipe-variant',
    domain: 'wardley',
    artifactDir: path.join(os.tmpdir(), 'labre-recipe-variant-artifacts'),
    auth: { userId: 'user-42' },
  };
}

const RECIPE_FLAG = '$feature/mcp-recipe-wardley-map-base-identify';

describe('run-recipe: recipe-experiment variant assignment (E2E)', () => {
  beforeEach(() => {
    resetRecipeCache();
    resetLLMRegistryCache();
    resetPromptRegistryCache();
    resetPromptsConfigCache();
    setLLMCallForTesting('identify-capability', 'text', async () => CANNED_RESPONSE);
  });

  afterEach(() => {
    setPostHogFlags(undefined);
    resetLLMRegistryCache();
    resetPromptRegistryCache();
    resetPromptsConfigCache();
  });

  it('runs the variant recipe and attributes the served variant on mcp_run_end', async () => {
    const projectRoot = await writeRecipes();
    const flags = buildRecipeVariantFlags('base-identify-b');
    setPostHogFlags(flags);

    const out = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:base-identify', input: { name: 'CRM', type: 'component' } },
      makeContext(projectRoot),
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'ok', `run errors: ${out.errors?.join('; ')}`);
    // The VARIANT recipe ran: its output key is present, the requested one's is not.
    assert.ok(out.ast?.resultB !== undefined, 'variant recipe (out: $.resultB) must have run');
    assert.equal(out.ast?.result, undefined, 'requested recipe (out: $.result) must NOT have run');

    // Attribution: the experiment key is on the REQUESTED ref, the value is the
    // served variant.
    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.ok(runEnd, 'mcp_run_end must be captured');
    assert.equal(runEnd.properties?.[RECIPE_FLAG], 'base-identify-b');
    assert.equal(runEnd.distinctId, 'user-42');
  });

  it('fails open to the requested recipe when the variant does not resolve', async () => {
    const projectRoot = await writeRecipes();
    const flags = buildRecipeVariantFlags('base-identify-does-not-exist');
    setPostHogFlags(flags);

    const out = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:base-identify', input: { name: 'CRM', type: 'component' } },
      makeContext(projectRoot),
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'ok', `run errors: ${out.errors?.join('; ')}`);
    // The REQUESTED recipe ran (fallback), not the missing variant.
    assert.ok(out.ast?.result !== undefined, 'requested recipe (out: $.result) must have run');
    assert.equal(out.ast?.resultB, undefined);

    // No recipe attribution: a variant that didn't run is never credited.
    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.ok(runEnd, 'mcp_run_end must be captured');
    assert.equal(runEnd.properties?.[RECIPE_FLAG], undefined);
  });

  it('runs the requested recipe unchanged when no variant is assigned', async () => {
    const projectRoot = await writeRecipes();
    const flags = buildRecipeVariantFlags(undefined);
    setPostHogFlags(flags);

    const out = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:base-identify', input: { name: 'CRM', type: 'component' } },
      makeContext(projectRoot),
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'ok', `run errors: ${out.errors?.join('; ')}`);
    assert.ok(out.ast?.result !== undefined);
    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.equal(runEnd?.properties?.[RECIPE_FLAG], undefined);
  });
});
