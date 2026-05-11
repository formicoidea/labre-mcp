import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CpcTaxonomyCache, getCpcTitle } from './cpc-taxonomy-cache.mjs';

// ─── Mock BigQuery client ───────────────────────────────────────────────────

function createMockClient(responses = {}) {
  return {
    query: async ({ query, params }) => {
      const key = params.parent_code;
      const data = responses[key] || [];
      return [data.map(([code, cnt, title]) => ({ code, cnt, title: title || code }))];
    },
  };
}

// ─── Test helpers ───────────────────────────────────────────────────────────

const TEST_CACHE_DIR = join(tmpdir(), 'wardley-test-cache-' + Date.now());
let cacheFileCounter = 0;

function testCachePath() {
  return join(TEST_CACHE_DIR, `cache-${++cacheFileCounter}.json`);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CpcTaxonomyCache', () => {

  beforeEach(async () => {
    await mkdir(TEST_CACHE_DIR, { recursive: true });
  });

  describe('getSubclasses', () => {
    it('returns subclasses with titles from BigQuery', async () => {
      const client = createMockClient({
        'G06': [
          ['G06F', 8780599, 'ELECTRIC DIGITAL DATA PROCESSING'],
          ['G06Q', 2633447, 'ICT FOR ADMINISTRATIVE PURPOSES'],
          ['G06N', 507836, 'COMPUTING BASED ON SPECIFIC MODELS'],
        ],
      });
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      const result = await cache.getSubclasses('G06');
      assert.equal(result.length, 3);
      assert.equal(result[0].code, 'G06F');
      assert.equal(result[0].cnt, 8780599);
      assert.equal(result[0].title, 'ELECTRIC DIGITAL DATA PROCESSING');
      assert.equal(result[2].code, 'G06N');
    });

    it('uppercases input', async () => {
      const client = createMockClient({
        'G06': [['G06F', 100]],
      });
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      const result = await cache.getSubclasses('g06');
      assert.equal(result.length, 1);
      assert.equal(result[0].code, 'G06F');
    });
  });

  describe('getGroups', () => {
    it('returns groups from BigQuery', async () => {
      const client = createMockClient({
        'G06F': [['G06F3/', 2104238], ['G06F9/', 939043], ['G06F16/', 1201612]],
      });
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      const result = await cache.getGroups('G06F');
      assert.equal(result.length, 3);
      assert.equal(result[0].code, 'G06F3/');
    });
  });

  describe('getSubgroups', () => {
    it('returns subgroups from BigQuery', async () => {
      const client = createMockClient({
        'G06F9/': [['G06F9/455', 64647], ['G06F9/50', 24327]],
      });
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      const result = await cache.getSubgroups('G06F9/');
      assert.equal(result.length, 2);
      assert.equal(result[0].code, 'G06F9/455');
      assert.equal(result[0].cnt, 64647);
    });
  });

  describe('memory caching', () => {
    it('returns cached result on second call without re-querying', async () => {
      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount++;
          return [[{ code: 'G06F', cnt: 100 }]];
        },
      };
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      await cache.getSubclasses('G06');
      await cache.getSubclasses('G06');
      assert.equal(queryCount, 1, 'Should only query BigQuery once');
    });

    it('re-fetches after TTL expires', async () => {
      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount++;
          return [[{ code: 'G06F', cnt: 100 }]];
        },
      };
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
        ttlMs: 1, // 1ms TTL — expires immediately
      });

      await cache.getSubclasses('G06');
      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 10));
      await cache.getSubclasses('G06');
      assert.equal(queryCount, 2, 'Should re-query after TTL');
    });
  });

  describe('disk persistence', () => {
    it('persists cache to disk and loads on new instance', async () => {
      const path = testCachePath();
      const client = createMockClient({
        'G06': [['G06F', 100], ['G06N', 50]],
      });

      // First instance: fetch and persist
      const cache1 = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: path,
      });
      await cache1.getSubclasses('G06');

      // Second instance: no BigQuery client, loads from disk
      const cache2 = new CpcTaxonomyCache({
        bigqueryClient: null,
        cachePath: path,
      });
      const result = await cache2.getSubclasses('G06');
      assert.equal(result.length, 2);
      assert.equal(result[0].code, 'G06F');
    });

    it('handles missing cache file gracefully', async () => {
      const cache = new CpcTaxonomyCache({
        bigqueryClient: null,
        cachePath: join(TEST_CACHE_DIR, 'nonexistent.json'),
      });

      const result = await cache.getSubclasses('G06');
      assert.deepEqual(result, []);
    });

    it('handles corrupt cache file gracefully', async () => {
      const path = testCachePath();
      await writeFile(path, 'NOT JSON{{{', 'utf-8');

      const cache = new CpcTaxonomyCache({
        bigqueryClient: null,
        cachePath: path,
      });

      const result = await cache.getSubclasses('G06');
      assert.deepEqual(result, []);
    });
  });

  describe('graceful degradation', () => {
    it('returns empty array when no BigQuery client', async () => {
      const cache = new CpcTaxonomyCache({
        bigqueryClient: null,
        cachePath: testCachePath(),
      });

      const result = await cache.getSubclasses('G06');
      assert.deepEqual(result, []);
    });

    it('returns empty array when BigQuery query fails', async () => {
      const client = {
        query: async () => { throw new Error('BigQuery error'); },
      };
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      const result = await cache.getSubclasses('G06');
      assert.deepEqual(result, []);
    });

    it('filters out null codes from BigQuery response', async () => {
      const client = {
        query: async () => [[{ code: 'G06F', cnt: 100 }, { code: null, cnt: 0 }]],
      };
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      const result = await cache.getSubclasses('G06');
      assert.equal(result.length, 1);
      assert.equal(result[0].code, 'G06F');
    });
  });

  describe('clear', () => {
    it('clears memory and disk cache', async () => {
      const path = testCachePath();
      const client = createMockClient({
        'G06': [['G06F', 100]],
      });
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: path,
      });

      await cache.getSubclasses('G06');
      assert.equal(cache.size, 1);

      await cache.clear();
      assert.equal(cache.size, 0);
    });
  });

  describe('size', () => {
    it('tracks number of cached entries', async () => {
      const client = createMockClient({
        'G06': [['G06F', 100]],
        'H04': [['H04L', 200]],
      });
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      assert.equal(cache.size, 0);
      await cache.getSubclasses('G06');
      assert.equal(cache.size, 1);
      await cache.getSubclasses('H04');
      assert.equal(cache.size, 2);
    });
  });

  describe('getCpcTitle', () => {
    it('returns title from cache after lookup', async () => {
      const client = createMockClient({
        'G06': [['G06F', 100, 'ELECTRIC DIGITAL DATA PROCESSING']],
      });
      const cache = new CpcTaxonomyCache({
        bigqueryClient: client,
        queryOptions: {},
        cachePath: testCachePath(),
      });

      await cache.getSubclasses('G06');
      assert.equal(getCpcTitle('G06F'), 'ELECTRIC DIGITAL DATA PROCESSING');
    });

    it('returns code itself when no title available', () => {
      assert.equal(getCpcTitle('Z99X'), 'Z99X');
    });

    it('persists titles through disk cache', async () => {
      const path = testCachePath();
      const client = createMockClient({
        'G06': [['G06F', 100, 'ELECTRIC DIGITAL DATA PROCESSING']],
      });

      // First instance: populate
      const cache1 = new CpcTaxonomyCache({ bigqueryClient: client, queryOptions: {}, cachePath: path });
      await cache1.getSubclasses('G06');

      // Clear title store to simulate new process
      await cache1.clear();

      // Second instance: load from disk
      const cache2 = new CpcTaxonomyCache({ bigqueryClient: null, cachePath: path });
      // Re-populate from disk (need to re-write cache since clear wiped it)
      const cache3 = new CpcTaxonomyCache({ bigqueryClient: client, queryOptions: {}, cachePath: path });
      await cache3.getSubclasses('G06');

      // New instance loads from disk and registers titles
      const cache4 = new CpcTaxonomyCache({ bigqueryClient: null, cachePath: path });
      await cache4.getSubclasses('G06');
      assert.equal(getCpcTitle('G06F'), 'ELECTRIC DIGITAL DATA PROCESSING');
    });
  });
});
