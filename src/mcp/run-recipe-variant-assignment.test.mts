// E2E-style test for prompt-experiment variant assignment (CP8).
//
// Proves the runRecipe tool threads a PostHog-resolved variant assignment all
// the way through the run:
//   1. flags.resolvePromptVariants → the runner's ALS store (getPrompt('default')
//      for the assigned strategy resolves the VARIANT prompt, not the default);
//   2. flags → the telemetry listener (mcp_run_end carries the PostHog-native
//      $feature/mcp-prompt-<strategyId> attribution property).
//
// All-fake, zero network: the LLM is stubbed (records the prompt text handed to
// it) and PostHog is a recording fake installed via setPostHogFlags. The prompt
// config is a TEMP config (WARDLEY_PROMPTS_CONFIG) carrying both a default and a
// `variant-b` identify-capability prompt so the variant resolves via the shipped
// branch — the identify strategy always calls getPrompt('identify-capability')
// with the default name, so the active variant is what redirects it.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { RUN_RECIPE_TOOL } from './run-recipe.tool.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import { resetRecipeCache } from '#core/recipe/recipe-loader.mjs';
import { setPostHogFlags } from '#lib/flags/state.mjs';
import type { PostHogFlags } from '#lib/flags/posthog.mjs';
import {
  setLLMCallForTesting,
  resetLLMRegistryCache,
} from '#lib/llm/registry.mjs';
import { resetPromptRegistryCache } from '#lib/prompts/registry.mjs';
import { resetPromptsConfigCache } from '#lib/prompts/config.loader.mjs';
// Side-effect: registers the identifyCapability parser the temp config references.
import '#lib/prompts/init.mjs';

interface RunRecipeResultShape {
  recipe: string;
  status: string;
  recipeRunId?: string;
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

const DEFAULT_USER = 'DEFAULT identify {{component}}';
const VARIANT_USER = 'VARIANT-B identify {{component}}';

// A temp prompts config carrying both the default and a variant-b entry for
// identify-capability, each a split template. Both reference the real
// identifyCapability parser (registered by init.mjs).
async function writePromptsConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'labre-variant-prompts-'));
  await writeFile(path.join(dir, 'default.system.md'), 'SYSTEM default.\n', 'utf8');
  await writeFile(path.join(dir, 'default.user.md'), DEFAULT_USER + '\n', 'utf8');
  await writeFile(path.join(dir, 'variant.system.md'), 'SYSTEM variant-b.\n', 'utf8');
  await writeFile(path.join(dir, 'variant.user.md'), VARIANT_USER + '\n', 'utf8');
  const config = {
    'identify-capability': {
      default: {
        kind: 'template',
        templateFile: { system: 'default.system.md', user: 'default.user.md' },
        variables: ['component'],
        parser: { kind: 'custom', id: 'identifyCapability' },
      },
      'variant-b': {
        kind: 'template',
        templateFile: { system: 'variant.system.md', user: 'variant.user.md' },
        variables: ['component'],
        parser: { kind: 'custom', id: 'identifyCapability' },
      },
    },
  };
  await writeFile(path.join(dir, 'prompts.config.json'), JSON.stringify(config), 'utf8');
  return path.join(dir, 'prompts.config.json');
}

// A projectRoot with a user recipe running the single identify step. A user
// recipe carries no bundle prompts — the only override in play is the variant
// assignment resolved from PostHog.
async function writeIdentifyRecipe(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'labre-variant-project-'));
  const recipeDir = path.join(projectRoot, 'recipes', 'wardley', 'map');
  await mkdir(recipeDir, { recursive: true });
  await writeFile(
    path.join(recipeDir, 'variant-identify.recipe.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      name: 'variant-identify',
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

// Recording fake PostHogFlags: assigns identify-capability → variant-b and
// records every telemetry capture. isRecipeEnabled allows (fail-open shape).
function buildVariantFlags(
  variants: Record<string, string>,
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
    async resolvePromptVariants() {
      return variants;
    },
    capture(event, distinctId, properties) {
      captured.push({ event, distinctId, properties });
    },
    async shutdown() {},
  };
}

describe('run-recipe: prompt-experiment variant assignment (E2E)', () => {
  beforeEach(() => {
    resetRecipeCache();
    resetLLMRegistryCache();
    resetPromptRegistryCache();
    resetPromptsConfigCache();
  });

  afterEach(() => {
    delete process.env.WARDLEY_PROMPTS_CONFIG;
    setPostHogFlags(undefined);
    resetLLMRegistryCache();
    resetPromptRegistryCache();
    resetPromptsConfigCache();
  });

  it('threads the assigned variant into the run and attributes it on mcp_run_end', async () => {
    process.env.WARDLEY_PROMPTS_CONFIG = await writePromptsConfig();
    const projectRoot = await writeIdentifyRecipe();

    const flags = buildVariantFlags({ 'identify-capability': 'variant-b' });
    setPostHogFlags(flags);

    const calls: Array<{ system: string | undefined; user: string }> = [];
    setLLMCallForTesting('identify-capability', 'text', async (
      user: string,
      _schema: unknown,
      opts: { systemPrompt?: string } | undefined,
    ): Promise<string> => {
      calls.push({ system: opts?.systemPrompt, user });
      return CANNED_RESPONSE;
    });

    const ctx: RequestContext = {
      projectId: 'test',
      projectRoot,
      sessionId: 's-variant',
      domain: 'wardley',
      artifactDir: path.join(os.tmpdir(), 'labre-variant-artifacts'),
      auth: { userId: 'user-42' },
    };

    const out = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:variant-identify', input: { name: 'CRM', type: 'component' } },
      ctx,
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'ok', `run errors: ${out.errors?.join('; ')}`);

    // 1. The run resolved the VARIANT prompt, not the default.
    const call = calls.find((c) => c.user.includes('CRM'));
    assert.ok(call, 'the run must have issued an LLM call');
    assert.match(call.user, /VARIANT-B identify/);
    assert.doesNotMatch(call.user, /DEFAULT identify/);
    assert.ok(call.system?.includes('SYSTEM variant-b.'));

    // 2. mcp_run_end carries the PostHog-native $feature/ attribution property.
    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.ok(runEnd, 'mcp_run_end must be captured');
    assert.equal(
      runEnd.properties?.['$feature/mcp-prompt-identify-capability'],
      'variant-b',
    );
    // Same distinctId as the gate (the authenticated user).
    assert.equal(runEnd.distinctId, 'user-42');
  });

  it('falls back to the default prompt (and adds no $feature/) when no variant is assigned', async () => {
    process.env.WARDLEY_PROMPTS_CONFIG = await writePromptsConfig();
    const projectRoot = await writeIdentifyRecipe();

    // Empty assignment → default path, no variant redirection, no attribution.
    const flags = buildVariantFlags({});
    setPostHogFlags(flags);

    const calls: Array<{ system: string | undefined; user: string }> = [];
    setLLMCallForTesting('identify-capability', 'text', async (
      user: string,
      _schema: unknown,
      _opts: { systemPrompt?: string } | undefined,
    ): Promise<string> => {
      calls.push({ system: _opts?.systemPrompt, user });
      return CANNED_RESPONSE;
    });

    const ctx: RequestContext = {
      projectId: 'test',
      projectRoot,
      sessionId: 's-default',
      domain: 'wardley',
      artifactDir: path.join(os.tmpdir(), 'labre-variant-artifacts-default'),
      auth: { userId: 'user-7' },
    };

    const out = (await RUN_RECIPE_TOOL.handler(
      { recipe: 'wardley:map:variant-identify', input: { name: 'CRM', type: 'component' } },
      ctx,
    )) as RunRecipeResultShape;

    assert.equal(out.status, 'ok', `run errors: ${out.errors?.join('; ')}`);

    const call = calls.find((c) => c.user.includes('CRM'));
    assert.ok(call, 'the run must have issued an LLM call');
    assert.match(call.user, /DEFAULT identify/);
    assert.doesNotMatch(call.user, /VARIANT-B identify/);

    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.ok(runEnd, 'mcp_run_end must be captured');
    const featureKeys = Object.keys(runEnd.properties ?? {}).filter((k) =>
      k.startsWith('$feature/'),
    );
    assert.deepEqual(featureKeys, []);
  });
});
