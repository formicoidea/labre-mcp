// E2E-style test for run-scoped bundle prompt overrides (CP5).
//
// All-fake, zero network: the LLM is stubbed via the registry's test-injection
// seam, so the "LLM call" simply records the prompt text it was handed and
// returns a canned, parseable capability response. The test proves two things
// at once:
//   1. a run of a BUNDLE recipe sees the bundle's overridden prompt text
//      (the run-scoped override store shadows the shipped prompt);
//   2. a CONCURRENT run of a non-bundle recipe in the same process sees the
//      SHIPPED prompt text — proving run-scope isolation (AsyncLocalStorage)
//      and that the override never poisons the module-global prompt cache.
//
// Both recipes are single-step `wardley:map:node:identify:default` runs so the
// identify-capability strategy's getPrompt() is the observable surface. The
// bundle is loaded through the real loadBundleFromDir → registerBundle path
// (with a distinctive overridden prompt pair); the shipped run uses a
// projectRoot recipe with the same step, which carries no bundle prompts.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { RUN_RECIPE_TOOL } from './run-recipe.tool.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { loadBundleFromDir, registerBundle } from '#lib/bundles/bundle-loader.mjs';
import { resetBundleRecipes, resetRecipeCache } from '#core/recipe/recipe-loader.mjs';
import {
  setLLMCallForTesting,
  resetLLMRegistryCache,
} from '#lib/llm/registry.mjs';
import { resetPromptRegistryCache } from '#lib/prompts/registry.mjs';
// Side-effect: registers the custom prompt parsers (identifyCapability, …)
// that shipped strategies resolve via getParser() — the daemon does this at
// boot, so the E2E must too or .parse() throws "parser not registered".
import '#lib/prompts/init.mjs';

// src/mcp/ → up 2 = repo root (shipped recipes + prompts.config.json).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface RunRecipeResultShape {
  recipe: string;
  status: string;
  errors?: string[];
}

// A parseable identify-capability response (5 mandatory key=value lines).
const CANNED_RESPONSE = [
  'type=component',
  'nature=activity',
  'capability=Manage customer relationships',
  'confidence=0.90',
  'justification=stub',
].join('\n');

// Distinctive bundle prompt text so we can tell it apart from the shipped one.
const BUNDLE_SYSTEM = 'BUNDLE SYSTEM PROMPT — a/b variant.\nIdentify the capability.';
const BUNDLE_USER =
  'BUNDLE USER PROMPT\nComponent: {{component}}\nDescription: {{description}}\nContext: {{context}}';

async function writeIdentifyBundle(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'labre-ab-bundle-'));
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: '0.1',
      slug: 'ab-identify-bundle',
      version: '1.0.0',
      description: 'A/B bundle overriding identify-capability/default',
      permissions: ['llm'],
      prompts: { 'identify-capability': ['default'] },
    }),
    'utf8',
  );
  await writeFile(
    path.join(dir, 'recipe.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      name: 'ab-identify-bundle',
      domain: 'wardley',
      tool: 'map',
      steps: [
        { stepId: 'identify', tool: 'wardley:map:node:identify:default', in: '$.input', out: '$.result' },
      ],
      listeners: {},
    }),
    'utf8',
  );
  await mkdir(path.join(dir, 'prompts', 'identify-capability'), { recursive: true });
  await writeFile(
    path.join(dir, 'prompts', 'identify-capability', 'default.system.md'),
    BUNDLE_SYSTEM + '\n',
    'utf8',
  );
  await writeFile(
    path.join(dir, 'prompts', 'identify-capability', 'default.user.md'),
    BUNDLE_USER + '\n',
    'utf8',
  );
  return dir;
}

// A projectRoot with a non-bundle recipe running the same identify step. Being
// a projectRoot (user) recipe, it carries NO bundle prompts → shipped prompt.
async function writeShippedStyleRecipe(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'labre-ab-project-'));
  const recipeDir = path.join(projectRoot, 'recipes', 'wardley', 'map');
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    path.join(recipeDir, 'shipped-identify.recipe.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      name: 'shipped-identify',
      domain: 'wardley',
      tool: 'map',
      steps: [
        { stepId: 'identify', tool: 'wardley:map:node:identify:default', in: '$.input', out: '$.result' },
      ],
      listeners: {},
    }),
    'utf8',
  );
  return projectRoot;
}

describe('run-recipe: run-scoped bundle prompt overrides (E2E)', () => {
  beforeEach(() => {
    resetBundleRecipes();
    resetRecipeCache();
    resetLLMRegistryCache();
    resetPromptRegistryCache();
  });

  afterEach(() => {
    resetLLMRegistryCache();
    resetPromptRegistryCache();
    resetBundleRecipes();
  });

  it('a bundle run sees the overridden prompt while a concurrent shipped run sees the shipped prompt', async () => {
    // Register the A/B bundle through the real load → register path.
    const bundleDir = await writeIdentifyBundle();
    const loaded = await loadBundleFromDir(bundleDir);
    registerBundle(loaded, { shippedRoot: REPO_ROOT });

    const projectRoot = await writeShippedStyleRecipe();

    // Record the (system, user) prompt text every stubbed LLM call receives,
    // tagged by which component name it carried so we can attribute each call
    // to its run (the two runs use different component names).
    const calls: Array<{ system: string | undefined; user: string }> = [];
    // The identify strategy calls: llmCall(user, undefined, { systemPrompt: system }).
    setLLMCallForTesting('identify-capability', 'text', async (
      user: string,
      _schema: unknown,
      opts: { systemPrompt?: string } | undefined,
    ): Promise<string> => {
      calls.push({ system: opts?.systemPrompt, user });
      return CANNED_RESPONSE;
    });

    const bundleCtx: RequestContext = {
      projectId: 'test',
      projectRoot: process.cwd(),
      sessionId: 's-bundle',
      domain: 'wardley',
      artifactDir: path.join(os.tmpdir(), 'labre-ab-artifacts-bundle'),
    };
    const shippedCtx: RequestContext = {
      projectId: 'test',
      projectRoot,
      sessionId: 's-shipped',
      domain: 'wardley',
      artifactDir: path.join(os.tmpdir(), 'labre-ab-artifacts-shipped'),
    };

    // Run both concurrently in the same process. If run-scope isolation were
    // broken (e.g. the override leaked into the module cache), the shipped run
    // could observe the bundle text or vice-versa.
    const [bundleOut, shippedOut] = (await Promise.all([
      RUN_RECIPE_TOOL.handler(
        { recipe: 'wardley:map:ab-identify-bundle', input: { name: 'BundleComponent', type: 'component' } },
        bundleCtx,
      ),
      RUN_RECIPE_TOOL.handler(
        { recipe: 'wardley:map:shipped-identify', input: { name: 'ShippedComponent', type: 'component' } },
        shippedCtx,
      ),
    ])) as [RunRecipeResultShape, RunRecipeResultShape];

    assert.equal(bundleOut.status, 'ok', `bundle run errors: ${bundleOut.errors?.join('; ')}`);
    assert.equal(shippedOut.status, 'ok', `shipped run errors: ${shippedOut.errors?.join('; ')}`);

    // Attribute each recorded call to its run via the interpolated component name.
    const bundleCall = calls.find((c) => c.user.includes('BundleComponent'));
    const shippedCall = calls.find((c) => c.user.includes('ShippedComponent'));
    assert.ok(bundleCall, 'the bundle run must have issued an LLM call');
    assert.ok(shippedCall, 'the shipped run must have issued an LLM call');

    // The bundle run received the OVERRIDDEN prompt text. The pair is stored
    // verbatim (the file's trailing newline included), so compare on inclusion.
    assert.match(bundleCall.user, /BUNDLE USER PROMPT/);
    assert.ok(bundleCall.system?.includes('BUNDLE SYSTEM PROMPT — a/b variant.'));

    // The shipped run received the SHIPPED prompt text — never the bundle's.
    assert.doesNotMatch(shippedCall.user, /BUNDLE USER PROMPT/);
    assert.ok(shippedCall.system, 'shipped run must carry a system prompt');
    assert.doesNotMatch(shippedCall.system, /BUNDLE SYSTEM PROMPT/);
    // Shipped identify-capability system prompt is the real shipped text.
    assert.match(shippedCall.system, /expert in Wardley Mapping/);
  });

  it('after the override run, a fresh run resolves the shipped prompt (no cache poisoning)', async () => {
    const bundleDir = await writeIdentifyBundle();
    const loaded = await loadBundleFromDir(bundleDir);
    registerBundle(loaded, { shippedRoot: REPO_ROOT });
    const projectRoot = await writeShippedStyleRecipe();

    const calls: Array<{ system: string | undefined; user: string }> = [];
    setLLMCallForTesting('identify-capability', 'text', async (
      user: string,
      _schema: unknown,
      opts: { systemPrompt?: string } | undefined,
    ): Promise<string> => {
      calls.push({ system: opts?.systemPrompt, user });
      return CANNED_RESPONSE;
    });

    const baseCtx = {
      projectId: 'test',
      domain: 'wardley' as const,
      artifactDir: path.join(os.tmpdir(), 'labre-ab-artifacts-seq'),
    };

    // First: the bundle (override) run.
    const first = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:ab-identify-bundle', input: { name: 'FirstComponent', type: 'component' } },
      { ...baseCtx, projectRoot: process.cwd(), sessionId: 's1' },
    )) as RunRecipeResultShape;
    assert.equal(first.status, 'ok');

    // Then: a plain shipped-style run. Must NOT observe the override left behind.
    const second = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:shipped-identify', input: { name: 'SecondComponent', type: 'component' } },
      { ...baseCtx, projectRoot, sessionId: 's2' },
    )) as RunRecipeResultShape;
    assert.equal(second.status, 'ok');

    const secondCall = calls.find((c) => c.user.includes('SecondComponent'));
    assert.ok(secondCall, 'the second run must have issued an LLM call');
    assert.doesNotMatch(secondCall.user, /BUNDLE USER PROMPT/);
    assert.doesNotMatch(secondCall.system ?? '', /BUNDLE SYSTEM PROMPT/);
  });
});
