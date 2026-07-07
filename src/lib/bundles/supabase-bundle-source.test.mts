import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSupabaseBundleSource,
  type BundleListingProbe,
  type SupabaseBundleClient,
  type SupabaseBundleClientFactory,
} from './supabase-bundle-source.mjs';
import {
  loadRecipe,
  resetBundleRecipes,
  resetRecipeCache,
} from '#core/recipe/recipe-loader.mjs';
import type { DegradationEvent } from '#lib/degradation/index.mjs';

// src/lib/bundles/ → up 3 = repo root (shipped recipes for collision checks).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ─── in-memory bundle fixtures ──────────────────────────────────────────────

const encoder = new TextEncoder();

function sha256Hex(text: string): string {
  return createHash('sha256').update(encoder.encode(text)).digest('hex');
}

/** Minimal valid bundle content (manifest + recipe + one prompt pair).
 *  The declared override targets the shipped `identify-capability/default`
 *  template — the overridability check (CP4) requires overrides to shadow a
 *  shipped template prompt, so a made-up strategy id would be rejected. */
function bundleContents(slug: string): Record<string, string> {
  return {
    'manifest.json': JSON.stringify({
      schemaVersion: '0.1',
      slug,
      version: '1.0.0',
      description: `Remote test bundle ${slug}`,
      permissions: ['llm'],
      prompts: { 'identify-capability': ['default'] },
    }),
    'recipe.json': JSON.stringify({
      schemaVersion: '1.0',
      name: slug,
      domain: 'wardley',
      tool: 'map',
      steps: [{ stepId: 's1', tool: 'wardley:map:node:identify:default' }],
      listeners: {},
    }),
    'prompts/identify-capability/default.system.md': 'You are a demo.\n',
    'prompts/identify-capability/default.user.md': 'Component: {{component}}\n',
  };
}

interface FakeStore {
  /** slug → file contents; a row + storage objects are derived from this. */
  bundles: Map<string, Record<string, string>>;
  /** Corrupt the recorded sha256 of this "<slug>:<path>" entry. */
  corruptHashOf?: string;
  /** Drop the storage object of this "<slug>:<path>" entry (download 404s). */
  missingObjectOf?: string;
  /** When true, probe() and listEnabled() both reject (network down / 401). */
  failListing?: boolean;
  /** Bump this to move a bundle's updated_at watermark. */
  updatedAt: Map<string, string>;
}

function makeStore(slugs: string[]): FakeStore {
  const store: FakeStore = { bundles: new Map(), updatedAt: new Map() };
  for (const slug of slugs) {
    store.bundles.set(slug, bundleContents(slug));
    store.updatedAt.set(slug, '2026-07-07T00:00:00Z');
  }
  return store;
}

interface Counters {
  factoryCalls: number;
  probes: number;
  listings: number;
  downloads: number;
  tokens: string[];
}

function makeCounters(): Counters {
  return { factoryCalls: 0, probes: 0, listings: 0, downloads: 0, tokens: [] };
}

function rowsOf(store: FakeStore): unknown[] {
  return [...store.bundles.entries()].map(([slug, files]) => ({
    id: `id-${slug}`,
    slug,
    version: '1.0.0',
    manifest: {},
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256:
        store.corruptHashOf === `${slug}:${path}`
          ? sha256Hex(`${content}-tampered`)
          : sha256Hex(content),
    })),
    storage_prefix: `bundles/${slug}/1.0.0`,
    enabled: true,
    updated_at: store.updatedAt.get(slug) ?? '2026-07-07T00:00:00Z',
  }));
}

function makeFakeFactory(store: FakeStore, counters: Counters): SupabaseBundleClientFactory {
  return async (bearerToken: string): Promise<SupabaseBundleClient> => {
    counters.factoryCalls += 1;
    counters.tokens.push(bearerToken);
    return {
      async probe(): Promise<BundleListingProbe> {
        counters.probes += 1;
        if (store.failListing) throw new Error('network down (probe)');
        const stamps = [...store.updatedAt.entries()]
          .filter(([slug]) => store.bundles.has(slug))
          .map(([, at]) => at)
          .sort();
        return { maxUpdatedAt: stamps.at(-1) ?? null, enabledCount: store.bundles.size };
      },
      async listEnabled(): Promise<unknown[]> {
        counters.listings += 1;
        if (store.failListing) throw new Error('network down (listing)');
        return rowsOf(store);
      },
      async download(storagePath: string): Promise<Uint8Array> {
        counters.downloads += 1;
        const match = /^bundles\/([^/]+)\/1\.0\.0\/(.+)$/.exec(storagePath);
        const slug = match?.[1];
        const path = match?.[2];
        const content = slug !== undefined ? store.bundles.get(slug)?.[path ?? ''] : undefined;
        if (
          content === undefined ||
          store.missingObjectOf === `${slug}:${path}`
        ) {
          throw new Error(`object not found: ${storagePath}`);
        }
        return encoder.encode(content);
      },
    };
  };
}

function buildSource(
  store: FakeStore,
  counters: Counters,
  events: DegradationEvent[],
  ttlSeconds: number,
) {
  return buildSupabaseBundleSource({
    supabaseUrl: 'https://test.supabase.co',
    anonKey: 'anon-key',
    ttlSeconds,
    shippedRoot: REPO_ROOT,
    clientFactory: makeFakeFactory(store, counters),
    onDegradation: (event) => events.push(event),
  });
}

async function resolveBundleRecipe(name: string) {
  return loadRecipe({ framework: 'wardley', tool: 'map', name, shippedRoot: REPO_ROOT });
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('supabase-bundle-source: refreshIfStale', () => {
  beforeEach(() => {
    resetBundleRecipes();
    resetRecipeCache();
  });

  it('happy path: enabled rows become recipes resolvable via loadRecipe', async () => {
    const store = makeStore(['remote-alpha', 'remote-beta']);
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    const source = buildSource(store, counters, events, 300);

    await source.refreshIfStale('caller-token-1');

    const alpha = await resolveBundleRecipe('remote-alpha');
    const beta = await resolveBundleRecipe('remote-beta');
    assert.equal(alpha.name, 'remote-alpha');
    assert.equal(beta.name, 'remote-beta');
    assert.deepEqual(events, [], 'no degradation on the happy path');
    assert.deepEqual(counters.tokens, ['caller-token-1'], 'caller token reaches the factory');
    // 2 bundles × 4 files each, all verified.
    assert.equal(counters.downloads, 8);
  });

  it('sha256 mismatch rejects that bundle only; the others load', async () => {
    const store = makeStore(['remote-alpha', 'remote-beta']);
    store.corruptHashOf = 'remote-alpha:recipe.json';
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    const source = buildSource(store, counters, events, 300);

    await source.refreshIfStale('tok');

    await assert.rejects(resolveBundleRecipe('remote-alpha'), /Recipe not found/);
    const beta = await resolveBundleRecipe('remote-beta');
    assert.equal(beta.name, 'remote-beta');

    assert.equal(events.length, 1);
    assert.match(events[0].reason, /remote-alpha@1\.0\.0/, 'degradation names slug@version');
    assert.match(events[0].reason, /sha256 mismatch/);
    assert.equal(events[0].source, 'strategy-bundles');
  });

  it('download failure rejects that bundle only; the others load', async () => {
    const store = makeStore(['remote-alpha', 'remote-beta']);
    store.missingObjectOf = 'remote-beta:prompts/identify-capability/default.user.md';
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    const source = buildSource(store, counters, events, 300);

    await source.refreshIfStale('tok');

    const alpha = await resolveBundleRecipe('remote-alpha');
    assert.equal(alpha.name, 'remote-alpha');
    await assert.rejects(resolveBundleRecipe('remote-beta'), /Recipe not found/);

    assert.equal(events.length, 1);
    assert.match(events[0].reason, /remote-beta@1\.0\.0/);
    assert.match(events[0].reason, /object not found/);
  });

  it('total listing failure keeps the previously registered set (stale-over-broken) and never throws', async () => {
    const store = makeStore(['remote-alpha']);
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    // ttl 0: every call is allowed to attempt a refresh.
    const source = buildSource(store, counters, events, 0);

    await source.refreshIfStale('tok');
    assert.equal((await resolveBundleRecipe('remote-alpha')).name, 'remote-alpha');

    store.failListing = true;
    await source.refreshIfStale('tok'); // must not throw

    // Previous set still serves.
    assert.equal((await resolveBundleRecipe('remote-alpha')).name, 'remote-alpha');
    assert.equal(events.length, 1);
    assert.match(events[0].reason, /serving previously loaded bundles/);
  });

  it('TTL: a second call within the window does not hit the client at all', async () => {
    const store = makeStore(['remote-alpha']);
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    const source = buildSource(store, counters, events, 300);

    await source.refreshIfStale('tok-1');
    await source.refreshIfStale('tok-2');

    assert.equal(counters.factoryCalls, 1, 'second call inside TTL must not build a client');
    assert.equal(counters.listings, 1);
  });

  it('unchanged probe bumps freshness without re-listing; a disabled bundle disappears on the next real refresh', async () => {
    const store = makeStore(['remote-alpha', 'remote-beta']);
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    const source = buildSource(store, counters, events, 0);

    await source.refreshIfStale('tok');
    assert.equal(counters.listings, 1);
    assert.equal((await resolveBundleRecipe('remote-beta')).name, 'remote-beta');

    // Nothing changed: probe short-circuits, no second listing/downloads.
    await source.refreshIfStale('tok');
    assert.equal(counters.probes, 1);
    assert.equal(counters.listings, 1, 'unchanged probe must skip the full listing');
    assert.equal(counters.downloads, 8);

    // Disable remote-beta: it leaves the RLS-visible set (count changes).
    store.bundles.delete('remote-beta');
    store.updatedAt.delete('remote-beta');
    await source.refreshIfStale('tok');

    assert.equal(counters.listings, 2, 'changed probe must trigger a full refresh');
    assert.equal((await resolveBundleRecipe('remote-alpha')).name, 'remote-alpha');
    await assert.rejects(
      resolveBundleRecipe('remote-beta'),
      /Recipe not found/,
      'disabled bundle must disappear after refresh',
    );
  });

  it('a bundle colliding with a shipped recipe is rejected at registration; the others stay', async () => {
    // "evaluate-map" ships in recipes/wardley/map/ — a remote bundle must
    // never shadow it.
    const store = makeStore(['evaluate-map', 'remote-alpha']);
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    const source = buildSource(store, counters, events, 300);

    await source.refreshIfStale('tok');

    assert.equal((await resolveBundleRecipe('remote-alpha')).name, 'remote-alpha');
    // The shipped recipe still resolves (from disk, not from the bundle).
    const shipped = await resolveBundleRecipe('evaluate-map');
    assert.equal(shipped.name, 'evaluate-map');

    assert.equal(events.length, 1);
    assert.match(events[0].reason, /evaluate-map@1\.0\.0/);
    assert.match(events[0].reason, /collides with the shipped recipe/);
  });

  it('a bundle whose prompt targets an unknown shipped prompt is rejected; the others load', async () => {
    const store = makeStore(['remote-alpha', 'remote-beta']);
    // Repoint remote-beta's declared override at a strategy that ships no
    // prompt — the overridability check (CP4) must reject it. The prompt files
    // still exist on disk under the new strategy id so the static loader passes
    // and the failure is specifically the overridability check.
    store.bundles.set('remote-beta', {
      'manifest.json': JSON.stringify({
        schemaVersion: '0.1',
        slug: 'remote-beta',
        version: '1.0.0',
        description: 'Remote test bundle remote-beta',
        permissions: ['llm'],
        prompts: { 'no-such-strategy': ['default'] },
      }),
      'recipe.json': JSON.stringify({
        schemaVersion: '1.0',
        name: 'remote-beta',
        domain: 'wardley',
        tool: 'map',
        steps: [{ stepId: 's1', tool: 'wardley:map:node:identify:default' }],
        listeners: {},
      }),
      'prompts/no-such-strategy/default.system.md': 'You are a demo.\n',
      'prompts/no-such-strategy/default.user.md': 'Component: {{component}}\n',
    });
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    const source = buildSource(store, counters, events, 300);

    await source.refreshIfStale('tok');

    // The valid bundle still resolves; the offending one does not register.
    assert.equal((await resolveBundleRecipe('remote-alpha')).name, 'remote-alpha');
    await assert.rejects(resolveBundleRecipe('remote-beta'), /Recipe not found/);

    assert.equal(events.length, 1);
    assert.match(events[0].reason, /remote-beta@1\.0\.0/, 'degradation names slug@version');
    assert.match(events[0].reason, /unknown shipped prompt/);
    assert.equal(events[0].source, 'strategy-bundles');
  });

  it('an invalid row is rejected with degradation; the others load', async () => {
    const store = makeStore(['remote-alpha']);
    const counters = makeCounters();
    const events: DegradationEvent[] = [];
    const source = buildSupabaseBundleSource({
      supabaseUrl: 'https://test.supabase.co',
      anonKey: 'anon-key',
      ttlSeconds: 300,
      shippedRoot: REPO_ROOT,
      clientFactory: async (token) => {
        const inner = await makeFakeFactory(store, counters)(token);
        return {
          ...inner,
          async listEnabled() {
            const rows = await inner.listEnabled();
            return [...rows, { slug: 'broken-row' /* missing everything else */ }];
          },
        };
      },
      onDegradation: (event) => events.push(event),
    });

    await source.refreshIfStale('tok');

    assert.equal((await resolveBundleRecipe('remote-alpha')).name, 'remote-alpha');
    assert.equal(events.length, 1);
    assert.match(events[0].reason, /strategy_bundles row failed validation/);
  });
});
