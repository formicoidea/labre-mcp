// CPC Taxonomy Cache: lazy-loaded hierarchical CPC code cache backed by BigQuery.
//
// Provides three levels of CPC hierarchy discovery:
//   1. getSubclasses(classCode)   — "G06" → ["G06F", "G06N", "G06Q", ...]
//   2. getGroups(subclassCode)    — "G06F" → ["G06F3/", "G06F9/", "G06F16/", ...]
//   3. getSubgroups(groupCode)    — "G06F9/" → ["G06F9/455", "G06F9/50", ...]
//
// Cache is populated lazily from BigQuery on first access, then stored:
//   - In-memory Map for fast repeated lookups
//   - On-disk JSON file for cross-session persistence
//
// TTL defaults to 30 days (CPC taxonomy changes infrequently).
//
// Used by cpc-mapper.mjs for progressive CPC code discovery:
//   LLM picks section → cache provides real subclasses → LLM picks → etc.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default TTL for cached entries: 30 days in milliseconds. */
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default cache file path. */
export const DEFAULT_CACHE_PATH = join(homedir(), '.wardley-assistant', 'cpc-cache.json');

/** BigQuery dataset for patent data. */
const BQ_TABLE = '`patents-public-data.patents.publications`';

// ─── SQL Templates ──────────────────────────────────────────────────────────

/**
 * SQL to get distinct 4-char subclasses under a 3-char class code.
 * e.g., "G06" → ["G06F", "G06N", "G06Q", ...]
 */
const SQL_SUBCLASSES = `
  SELECT DISTINCT SUBSTR(cpc.code, 1, 4) AS code, COUNT(*) AS cnt
  FROM ${BQ_TABLE}, UNNEST(cpc) AS cpc
  WHERE SUBSTR(cpc.code, 1, 3) = @parent_code AND cpc.first = TRUE
  GROUP BY code
  ORDER BY cnt DESC
`;

/**
 * SQL to get distinct groups under a 4-char subclass code.
 * e.g., "G06F" → ["G06F3/", "G06F9/", "G06F16/", ...]
 * Uses regex to extract the group prefix (subclass + digits + slash).
 */
const SQL_GROUPS = `
  SELECT DISTINCT REGEXP_EXTRACT(cpc.code, r"^([A-H][0-9]{2}[A-Z][0-9]+/)") AS code, COUNT(*) AS cnt
  FROM ${BQ_TABLE}, UNNEST(cpc) AS cpc
  WHERE SUBSTR(cpc.code, 1, 4) = @parent_code AND cpc.first = TRUE
  GROUP BY code
  HAVING code IS NOT NULL
  ORDER BY cnt DESC
`;

/**
 * SQL to get distinct subgroups under a group prefix.
 * e.g., "G06F9/" → ["G06F9/455", "G06F9/50", "G06F9/4881", ...]
 * Only returns the top 50 by patent count to keep cache manageable.
 */
const SQL_SUBGROUPS = `
  SELECT DISTINCT cpc.code AS code, COUNT(*) AS cnt
  FROM ${BQ_TABLE}, UNNEST(cpc) AS cpc
  WHERE STARTS_WITH(cpc.code, @parent_code) AND cpc.first = TRUE
  GROUP BY code
  ORDER BY cnt DESC
  LIMIT 50
`;

// ─── Cache entry shape ──────────────────────────────────────────────────────

/**
 * @typedef {Object} CacheEntry
 * @property {Array<{code: string, cnt: number}>} children - Child codes with patent counts
 * @property {number} fetchedAt - Timestamp when this entry was fetched
 */

// ─── CpcTaxonomyCache class ────────────────────────────────────────────────

export class CpcTaxonomyCache {

  /**
   * @param {Object} options
   * @param {Object} options.bigqueryClient - BigQuery client instance (from bigquery-client.mjs getClient())
   * @param {Object} options.queryOptions - Default query options (from defaultQueryOptions())
   * @param {string} [options.cachePath] - Path to on-disk cache file
   * @param {number} [options.ttlMs] - Cache TTL in milliseconds (default: 30 days)
   */
  constructor({ bigqueryClient, queryOptions, cachePath, ttlMs } = {}) {
    this._client = bigqueryClient || null;
    this._queryOptions = queryOptions || {};
    this._cachePath = cachePath || DEFAULT_CACHE_PATH;
    this._ttlMs = ttlMs ?? DEFAULT_TTL_MS;

    /** @type {Map<string, CacheEntry>} */
    this._memory = new Map();
    this._diskLoaded = false;
  }

  /**
   * Get subclasses of a CPC class (3-char code → 4-char codes).
   * @param {string} classCode - 3-char class code (e.g., "G06")
   * @returns {Promise<Array<{code: string, cnt: number}>>}
   */
  async getSubclasses(classCode) {
    const key = classCode.toUpperCase();
    return this._getOrFetch(key, SQL_SUBCLASSES);
  }

  /**
   * Get groups of a CPC subclass (4-char code → group prefixes).
   * @param {string} subclassCode - 4-char subclass code (e.g., "G06F")
   * @returns {Promise<Array<{code: string, cnt: number}>>}
   */
  async getGroups(subclassCode) {
    const key = subclassCode.toUpperCase();
    return this._getOrFetch(key, SQL_GROUPS);
  }

  /**
   * Get subgroups of a CPC group (group prefix → full codes).
   * @param {string} groupCode - Group prefix (e.g., "G06F9/")
   * @returns {Promise<Array<{code: string, cnt: number}>>}
   */
  async getSubgroups(groupCode) {
    const key = groupCode.toUpperCase();
    return this._getOrFetch(key, SQL_SUBGROUPS);
  }

  /**
   * Get cached children or fetch from BigQuery.
   * @param {string} parentCode - Parent CPC code
   * @param {string} sql - SQL template to use
   * @returns {Promise<Array<{code: string, cnt: number}>>}
   * @private
   */
  async _getOrFetch(parentCode, sql) {
    // Check memory cache first
    const cached = this._memory.get(parentCode);
    if (cached && (Date.now() - cached.fetchedAt) < this._ttlMs) {
      return cached.children;
    }

    // Load disk cache on first access
    if (!this._diskLoaded) {
      await this._loadFromDisk();
      this._diskLoaded = true;

      // Re-check after disk load
      const diskCached = this._memory.get(parentCode);
      if (diskCached && (Date.now() - diskCached.fetchedAt) < this._ttlMs) {
        return diskCached.children;
      }
    }

    // Fetch from BigQuery
    const children = await this._fetchFromBigQuery(parentCode, sql);

    // Store in memory + persist to disk
    const entry = { children, fetchedAt: Date.now() };
    this._memory.set(parentCode, entry);
    await this._saveToDisk();

    return children;
  }

  /**
   * Fetch CPC hierarchy data from BigQuery.
   * @param {string} parentCode - Parent CPC code
   * @param {string} sql - SQL query template
   * @returns {Promise<Array<{code: string, cnt: number}>>}
   * @private
   */
  async _fetchFromBigQuery(parentCode, sql) {
    if (!this._client) {
      return [];
    }

    try {
      const [rows] = await this._client.query({
        query: sql,
        params: { parent_code: parentCode },
        ...this._queryOptions,
      });

      return rows
        .filter(r => r.code)
        .map(r => ({ code: r.code, cnt: Number(r.cnt) || 0 }));
    } catch (err) {
      // Log but don't throw — cache gracefully degrades to empty
      if (typeof process !== 'undefined' && process.env.WARDLEY_VERBOSE) {
        console.error(`CpcTaxonomyCache: BigQuery fetch failed for "${parentCode}":`, err.message);
      }
      return [];
    }
  }

  /**
   * Load cache from disk JSON file.
   * @private
   */
  async _loadFromDisk() {
    try {
      const raw = await readFile(this._cachePath, 'utf-8');
      const data = JSON.parse(raw);

      if (data && typeof data === 'object') {
        for (const [key, entry] of Object.entries(data)) {
          if (entry?.children && entry?.fetchedAt) {
            this._memory.set(key, entry);
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  /**
   * Persist cache to disk JSON file.
   * @private
   */
  async _saveToDisk() {
    try {
      const data = Object.fromEntries(this._memory.entries());
      await mkdir(dirname(this._cachePath), { recursive: true });
      await writeFile(this._cachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Disk write failed — non-critical, memory cache still works
    }
  }

  /**
   * Clear all cached entries (memory + disk).
   */
  async clear() {
    this._memory.clear();
    try {
      await writeFile(this._cachePath, '{}', 'utf-8');
    } catch {
      // Ignore disk errors
    }
  }

  /**
   * Get the number of cached entries.
   * @returns {number}
   */
  get size() {
    return this._memory.size;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a CpcTaxonomyCache with BigQuery client from environment.
 * Fails gracefully if BigQuery is not configured — returns a cache
 * that always returns empty arrays.
 *
 * @param {Object} [options]
 * @param {string} [options.cachePath] - Override cache file path
 * @param {number} [options.ttlMs] - Override TTL
 * @returns {Promise<CpcTaxonomyCache>}
 */
export async function createTaxonomyCache(options = {}) {
  try {
    const { resolveConfig, getClient, defaultQueryOptions } = await import('./bigquery-client.mjs');
    const config = resolveConfig();
    const client = await getClient(config);
    const queryOptions = defaultQueryOptions(config);

    return new CpcTaxonomyCache({
      bigqueryClient: client,
      queryOptions,
      cachePath: options.cachePath,
      ttlMs: options.ttlMs,
    });
  } catch {
    // BigQuery not configured — return cache that works from disk only
    return new CpcTaxonomyCache({
      cachePath: options.cachePath,
      ttlMs: options.ttlMs,
    });
  }
}
