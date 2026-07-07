import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundleFromDir, registerBundle } from './bundle-loader.mjs';
import {
  loadRecipe,
  resetBundleRecipes,
  resetRecipeCache,
  getBundlePrompts,
} from '#core/recipe/recipe-loader.mjs';

// src/lib/bundles/ → up 3 = repo root (shipped recipes + dogfood fixture).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXAMPLE_BUNDLE_DIR = join(REPO_ROOT, 'bundles', 'examples', 'evaluate-map-example');

// ─── temp-bundle scaffolding ────────────────────────────────────────────────

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '0.1',
    slug: 'demo-bundle',
    version: '1.0.0',
    description: 'Temp bundle for loader tests',
    permissions: ['llm'],
    ...overrides,
  };
}

function baseRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    name: 'demo-bundle',
    domain: 'wardley',
    tool: 'map',
    steps: [{ stepId: 's1', tool: 'wardley:map:node:identify:default' }],
    listeners: {},
    ...overrides,
  };
}

interface TempBundleSpec {
  manifest?: Record<string, unknown>;
  recipe?: Record<string, unknown>;
  /** Extra files, path relative to the bundle root → content. */
  files?: Record<string, string>;
}

async function writeTempBundle(spec: TempBundleSpec = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'labre-bundle-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(spec.manifest ?? baseManifest()), 'utf8');
  await writeFile(join(dir, 'recipe.json'), JSON.stringify(spec.recipe ?? baseRecipe()), 'utf8');
  for (const [relative, content] of Object.entries(spec.files ?? {})) {
    const full = join(dir, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

// ─── loadBundleFromDir ──────────────────────────────────────────────────────

describe('bundle-loader: loadBundleFromDir', () => {
  it('loads the shipped example bundle (dogfood fixture)', async () => {
    const loaded = await loadBundleFromDir(EXAMPLE_BUNDLE_DIR);

    assert.equal(loaded.manifest.slug, 'evaluate-map-example');
    assert.equal(loaded.manifest.schemaVersion, '0.1');
    assert.deepEqual(loaded.manifest.permissions, ['llm']);
    assert.equal(loaded.recipe.name, 'evaluate-map-example');
    assert.equal(loaded.recipe.domain, 'wardley');
    assert.equal(loaded.recipe.tool, 'map');
    assert.equal(loaded.recipe.steps.length, 3);

    const pair = loaded.prompts['identify-capability']?.['default'];
    assert.ok(pair, 'declared prompt pair must be loaded');
    // CRLF-normalized (git may check the fixture out with CRLF on Windows).
    assert.ok(!pair.system.includes('\r'), 'system text must be LF-normalized');
    assert.ok(!pair.user.includes('\r'), 'user text must be LF-normalized');
    assert.match(pair.user, /\{\{component\}\}/);
    assert.doesNotMatch(pair.system, /\{\{\w+\}\}/);
  });

  it('deduplicates manifest permissions on parse', async () => {
    const dir = await writeTempBundle({
      manifest: baseManifest({ permissions: ['llm', 'render', 'llm'] }),
    });
    const loaded = await loadBundleFromDir(dir);
    assert.deepEqual(loaded.manifest.permissions, ['llm', 'render']);
  });

  it('rejects a manifest with a missing required field', async () => {
    const manifest = baseManifest();
    delete manifest['description'];
    const dir = await writeTempBundle({ manifest });
    await assert.rejects(loadBundleFromDir(dir), /manifest\.json failed validation/);
  });

  it('rejects a recipe step whose tool violates the 5-segment methodId grammar', async () => {
    const dir = await writeTempBundle({
      recipe: baseRecipe({ steps: [{ stepId: 's1', tool: 'wardley:map:identify' }] }),
    });
    await assert.rejects(loadBundleFromDir(dir), /recipe\.json failed validation/);
    await assert.rejects(loadBundleFromDir(dir), /5 colon-separated segments/);
  });

  it('rejects a declared prompt pair missing on disk', async () => {
    const dir = await writeTempBundle({
      manifest: baseManifest({ prompts: { 'demo-strategy': ['default'] } }),
      files: {
        // Only the system half exists — the user half is missing.
        'prompts/demo-strategy/default.system.md': 'You are a demo.\n',
      },
    });
    await assert.rejects(loadBundleFromDir(dir), /cannot read user file/);
  });

  it('rejects a system file containing {{var}} placeholders', async () => {
    const dir = await writeTempBundle({
      manifest: baseManifest({ prompts: { 'demo-strategy': ['default'] } }),
      files: {
        'prompts/demo-strategy/default.system.md': 'You are {{who}}.',
        'prompts/demo-strategy/default.user.md': 'Component: {{component}}',
      },
    });
    await assert.rejects(loadBundleFromDir(dir), /system file must not contain \{\{\.\.\.\}\} placeholders/);
    await assert.rejects(loadBundleFromDir(dir), /"who"/);
  });

  it('rejects declared prompt pairs when "llm" permission is missing', async () => {
    const dir = await writeTempBundle({
      manifest: baseManifest({ permissions: ['render'], prompts: { 'demo-strategy': ['default'] } }),
      files: {
        'prompts/demo-strategy/default.system.md': 'You are a demo.',
        'prompts/demo-strategy/default.user.md': 'Do {{thing}}.',
      },
    });
    await assert.rejects(loadBundleFromDir(dir), /declares prompts but "permissions" is missing "llm"/);
  });

  it('rejects a recipe whose name differs from the manifest slug', async () => {
    const dir = await writeTempBundle({
      recipe: baseRecipe({ name: 'other-name' }),
    });
    await assert.rejects(loadBundleFromDir(dir), /"name" \("other-name"\) must equal manifest\.json "slug" \("demo-bundle"\)/);
  });

  it('names the bundle dir when manifest.json itself is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'labre-bundle-empty-'));
    await assert.rejects(loadBundleFromDir(dir), /cannot read manifest\.json/);
  });
});

// ─── registerBundle (runRecipe lookup path) ─────────────────────────────────

describe('bundle-loader: registerBundle', () => {
  beforeEach(() => {
    resetBundleRecipes();
    resetRecipeCache();
  });

  it('makes the bundle recipe resolvable through loadRecipe', async () => {
    const loaded = await loadBundleFromDir(EXAMPLE_BUNDLE_DIR);
    registerBundle(loaded, { shippedRoot: REPO_ROOT });

    const resolved = await loadRecipe({
      framework: 'wardley',
      tool: 'map',
      name: 'evaluate-map-example',
      shippedRoot: REPO_ROOT,
    });
    assert.equal(resolved, loaded.recipe);
  });

  it('carries the bundle prompts through registration (retrievable by ref)', async () => {
    const loaded = await loadBundleFromDir(EXAMPLE_BUNDLE_DIR);
    registerBundle(loaded, { shippedRoot: REPO_ROOT });

    const prompts = getBundlePrompts(
      { framework: 'wardley', tool: 'map', name: 'evaluate-map-example' },
      loaded.recipe,
    );
    const pair = prompts?.['identify-capability']?.['default'];
    assert.ok(pair, 'the declared prompt pair survives registration');
    assert.match(pair.user, /\{\{component\}\}/);
    assert.doesNotMatch(pair.system, /\{\{\w+\}\}/);
    // Same object the loader produced — no copy/transform on the way through.
    assert.equal(prompts, loaded.prompts);
  });

  it('rejects a bundle whose prompt targets an unknown shipped prompt', async () => {
    // "demo-strategy" ships no prompt — the override would be unreachable.
    const dir = await writeTempBundle({
      manifest: baseManifest({ prompts: { 'demo-strategy': ['default'] } }),
      files: {
        'prompts/demo-strategy/default.system.md': 'You are a demo.',
        'prompts/demo-strategy/default.user.md': 'Do {{thing}}.',
      },
    });
    const loaded = await loadBundleFromDir(dir);
    assert.throws(
      () => registerBundle(loaded, { shippedRoot: REPO_ROOT }),
      /demo-strategy\/default.*unknown shipped prompt/s,
    );
    // Rejected before registration — the recipe never became resolvable.
    assert.equal(
      getBundlePrompts({ framework: 'wardley', tool: 'map', name: 'demo-bundle' }, loaded.recipe),
      undefined,
    );
  });

  it('rejects a slug colliding with a shipped recipe name', async () => {
    // Same ref as the shipped recipes/wardley/map/evaluate-map.recipe.json.
    const dir = await writeTempBundle({
      manifest: baseManifest({ slug: 'evaluate-map' }),
      recipe: baseRecipe({ name: 'evaluate-map' }),
    });
    const loaded = await loadBundleFromDir(dir);
    assert.throws(
      () => registerBundle(loaded, { shippedRoot: REPO_ROOT }),
      /collides with the shipped recipe/,
    );
  });

  it('rejects registering the same bundle ref twice', async () => {
    const loaded = await loadBundleFromDir(EXAMPLE_BUNDLE_DIR);
    registerBundle(loaded, { shippedRoot: REPO_ROOT });
    assert.throws(
      () => registerBundle(loaded, { shippedRoot: REPO_ROOT }),
      /already registered/,
    );
  });

  it('does not shadow a user projectRoot override', async () => {
    const loaded = await loadBundleFromDir(EXAMPLE_BUNDLE_DIR);
    registerBundle(loaded, { shippedRoot: REPO_ROOT });

    // A projectRoot recipe with the same ref wins over the registered bundle.
    const projectRoot = await mkdtemp(join(tmpdir(), 'labre-project-'));
    const overrideDir = join(projectRoot, 'recipes', 'wardley', 'map');
    await mkdir(overrideDir, { recursive: true });
    await writeFile(
      join(overrideDir, 'evaluate-map-example.recipe.json'),
      JSON.stringify(baseRecipe({ name: 'evaluate-map-example' })),
      'utf8',
    );

    const resolved = await loadRecipe({
      framework: 'wardley',
      tool: 'map',
      name: 'evaluate-map-example',
      shippedRoot: REPO_ROOT,
      projectRoot,
    });
    assert.notEqual(resolved, loaded.recipe);
    assert.equal(resolved.steps[0].stepId, 's1');
  });
});
