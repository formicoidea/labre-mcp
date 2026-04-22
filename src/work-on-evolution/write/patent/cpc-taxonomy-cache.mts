// CPC Taxonomy Cache: lazy-loaded hierarchical CPC code cache backed by BigQuery.
//
// Provides three levels of CPC hierarchy discovery with titles from
// patents-public-data.cpc.definition (authoritative CPC taxonomy, all sections A-H + Y):
//   1. getSubclasses(classCode)   — "G06" → [{code:"G06F", cnt:8M, title:"ELECTRIC DIGITAL DATA PROCESSING"}, ...]
//   2. getGroups(subclassCode)    — "G06F" → [{code:"G06F9/", cnt:939K, title:"Arrangements for program control"}, ...]
//   3. getSubgroups(groupCode)    — "G06F9/" → [{code:"G06F9/455", cnt:64K, title:"Emulation; Virtualisation"}, ...]
//
// Each entry includes { code, cnt, title } — titles come from BigQuery JOIN with cpc.definition.
//
// Cache is populated lazily from BigQuery on first access, then stored:
//   - In-memory Map for fast repeated lookups
//   - On-disk JSON file for cross-session persistence
//
// getCpcTitle(code) resolves titles from the cache (no static file needed).
//
// TTL defaults to 30 days (CPC taxonomy changes infrequently).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { CpcEntry, BigQueryRow } from '../../../types/patent.mjs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { toErrorMessage, errorCode } from '../../../lib/errors.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default TTL for cached entries: 30 days in milliseconds. */
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default cache file path. */
export const DEFAULT_CACHE_PATH = join(homedir(), '.wardley-assistant', 'cpc-cache.json');

/** BigQuery tables. */
const BQ_PUBLICATIONS = '`patents-public-data.patents.publications`';
const BQ_CPC_DEF = '`patents-public-data.cpc.definition`';

// ─── SQL Templates (with JOIN cpc.definition for titles) ────────────────────

/**
 * SQL: subclasses of a 3-char class code, with titles from cpc.definition.
 * e.g., "G06" → [{code:"G06F", cnt:8780599, title:"ELECTRIC DIGITAL DATA PROCESSING"}, ...]
 */
const SQL_SUBCLASSES = `
  SELECT sc.code, sc.cnt, IFNULL(def.titleFull, sc.code) AS title
  FROM (
    SELECT DISTINCT SUBSTR(cpc.code, 1, 4) AS code, COUNT(*) AS cnt
    FROM ${BQ_PUBLICATIONS}, UNNEST(cpc) AS cpc
    WHERE SUBSTR(cpc.code, 1, 3) = @parent_code AND cpc.first = TRUE
    GROUP BY code
  ) sc
  LEFT JOIN ${BQ_CPC_DEF} def ON def.symbol = sc.code
  ORDER BY sc.cnt DESC
`;

/**
 * SQL: groups of a 4-char subclass code, with titles from cpc.definition.
 * Groups in publications are like "G06F9/" but in cpc.definition they are "G06F9/00".
 * JOIN uses CONCAT(code, '00') to match.
 */
const SQL_GROUPS = `
  SELECT grp.code, grp.cnt, IFNULL(def.titleFull, grp.code) AS title
  FROM (
    SELECT DISTINCT REGEXP_EXTRACT(cpc.code, r"^([A-H][0-9]{2}[A-Z][0-9]+/)") AS code, COUNT(*) AS cnt
    FROM ${BQ_PUBLICATIONS}, UNNEST(cpc) AS cpc
    WHERE SUBSTR(cpc.code, 1, 4) = @parent_code AND cpc.first = TRUE
    GROUP BY code
    HAVING code IS NOT NULL
  ) grp
  LEFT JOIN ${BQ_CPC_DEF} def ON def.symbol = CONCAT(grp.code, '00')
  ORDER BY grp.cnt DESC
`;

/**
 * SQL: subgroups of a group prefix, with titles from cpc.definition.
 * Top 50 by patent count.
 */
const SQL_SUBGROUPS = `
  SELECT sg.code, sg.cnt, IFNULL(def.titleFull, sg.code) AS title
  FROM (
    SELECT DISTINCT cpc.code AS code, COUNT(*) AS cnt
    FROM ${BQ_PUBLICATIONS}, UNNEST(cpc) AS cpc
    WHERE STARTS_WITH(cpc.code, @parent_code) AND cpc.first = TRUE
    GROUP BY code
    ORDER BY cnt DESC
    LIMIT 50
  ) sg
  LEFT JOIN ${BQ_CPC_DEF} def ON def.symbol = sg.code
  ORDER BY sg.cnt DESC
`;

// ─── Cache entry shape ──────────────────────────────────────────────────────

/**
 * @typedef {Object} CpcEntry
 * @property {string} code - CPC code
 * @property {number} cnt - Patent count
 * @property {string} title - Human-readable title from cpc.definition
 */

/**
 * @typedef {Object} CacheEntry
 * @property {CpcEntry[]} children - Child codes with patent counts and titles
 * @property {number} fetchedAt - Timestamp when this entry was fetched
 */

// ─── CPC Title resolution from cache ────────────────────────────────────────

/** @type {Map<string, string>} Global title store populated from cache entries. */
const _titleStore = new Map();

/**
 * Get the human-readable title for a CPC code.
 * Resolves from the in-memory title store (populated by cache lookups).
 *
 * Fallback chain:
 *   1. Exact match in title store
 *   2. Trimmed trailing zeros (G06F9/50 → G06F9/5)
 *   3. Parent group (G06F9/455 → G06F9/)
 *   4. The code itself
 *
 * @param {string} code - CPC code at any hierarchy level
 * @returns {string}
 */
export function getCpcTitle(code: string): string {
  if (_titleStore.has(code)) return _titleStore.get(code);

  // Try trimming trailing zeros (BigQuery: G06F9/50 → cpc.definition: G06F9/5)
  if (code.includes('/')) {
    const trimmed = code.replace(/0+$/, '');
    if (_titleStore.has(trimmed)) return _titleStore.get(trimmed);
  }

  // Try parent group (G06F9/455 → G06F9/)
  const slashIdx = code.indexOf('/');
  if (slashIdx > 0) {
    const group = code.substring(0, slashIdx + 1);
    if (_titleStore.has(group)) return _titleStore.get(group);
  }

  return code;
}

/**
 * Register a title in the global store.
 * Called internally when cache entries are loaded, or externally
 * by the strategy to register titles from progressive discovery.
 * @param {string} code
 * @param {string} title
 */
export function setCpcTitle(code: string, title: string): void {
  if (code && title && title !== code) {
    _titleStore.set(code, title);
  }
}

// ─── CpcTaxonomyCache class ────────────────────────────────────────────────

export class CpcTaxonomyCache {
  _client: any;  // any: BigQuery client (lazy, no exposed types)
  _queryOptions: Record<string, unknown>;
  _cachePath: string;
  _ttlMs: number;
  _memory: Map<string, { children: CpcEntry[]; fetchedAt: number }>;
  _diskLoaded: boolean;

  constructor({ bigqueryClient, queryOptions, cachePath, ttlMs }: { bigqueryClient?: any; queryOptions?: Record<string, unknown>; cachePath?: string; ttlMs?: number } = {}) {
    this._client = bigqueryClient || null;
    this._queryOptions = queryOptions || {};
    this._cachePath = cachePath || DEFAULT_CACHE_PATH;
    this._ttlMs = ttlMs ?? DEFAULT_TTL_MS;

    /** @type {Map<string, CacheEntry>} */
    this._memory = new Map();
    this._diskLoaded = false;
  }

  /**
   * Get subclasses of a CPC class (3-char code → 4-char codes with titles).
   * @param {string} classCode - 3-char class code (e.g., "G06")
   * @returns {Promise<CpcEntry[]>}
   */
  async getSubclasses(classCode: string): Promise<CpcEntry[]> {
    const key = classCode.toUpperCase();
    return this._getOrFetch(key, SQL_SUBCLASSES);
  }

  /**
   * Get groups of a CPC subclass (4-char code → group prefixes with titles).
   * @param {string} subclassCode - 4-char subclass code (e.g., "G06F")
   * @returns {Promise<CpcEntry[]>}
   */
  async getGroups(subclassCode: string): Promise<CpcEntry[]> {
    const key = subclassCode.toUpperCase();
    return this._getOrFetch(key, SQL_GROUPS);
  }

  /**
   * Get subgroups of a CPC group (group prefix → full codes with titles).
   * @param {string} groupCode - Group prefix (e.g., "G06F9/")
   * @returns {Promise<CpcEntry[]>}
   */
  async getSubgroups(groupCode: string): Promise<CpcEntry[]> {
    const key = groupCode.toUpperCase();
    return this._getOrFetch(key, SQL_SUBGROUPS);
  }

  /**
   * Get cached children or fetch from BigQuery.
   * Registers titles in the global store on load.
   * @private
   */
  async _getOrFetch(parentCode: string, sql: string): Promise<CpcEntry[]> {
    // Check memory cache first
    const cached = this._memory.get(parentCode);
    if (cached && (Date.now() - cached.fetchedAt) < this._ttlMs) {
      // Re-register titles (may have been lost if title store was cleared)
      for (const child of cached.children) setCpcTitle(child.code, child.title ?? child.code);
      return cached.children;
    }

    // Load disk cache on first access
    if (!this._diskLoaded) {
      await this._loadFromDisk();
      this._diskLoaded = true;

      const diskCached = this._memory.get(parentCode);
      if (diskCached && (Date.now() - diskCached.fetchedAt) < this._ttlMs) {
        for (const child of diskCached.children) setCpcTitle(child.code, child.title ?? child.code);
        return diskCached.children;
      }
    }

    // Fetch from BigQuery
    const children = await this._fetchFromBigQuery(parentCode, sql);

    // Register titles
    for (const child of children) setCpcTitle(child.code, child.title ?? child.code);

    // Store in memory + persist to disk
    const entry = { children, fetchedAt: Date.now() };
    this._memory.set(parentCode, entry);
    await this._saveToDisk();

    return children;
  }

  /**
   * Fetch CPC hierarchy data from BigQuery (with titles from cpc.definition).
   * @private
   */
  async _fetchFromBigQuery(parentCode: string, sql: string): Promise<CpcEntry[]> {
    if (!this._client) return [];

    try {
      const [rows] = await this._client.query({
        query: sql,
        params: { parent_code: parentCode },
        ...this._queryOptions,
      });

      return rows
        .filter((r: BigQueryRow) => r.code)
        .map((r: BigQueryRow) => ({
          code: r.code,
          cnt: Number(r.cnt) || 0,
          title: r.title || r.code,
        }));
    } catch (err) {
      if (typeof process !== 'undefined' && process.env.WARDLEY_VERBOSE) {
        console.error(`CpcTaxonomyCache: BigQuery fetch failed for "${parentCode}":`, toErrorMessage(err));
      }
      return [];
    }
  }

  /** @private */
  async _loadFromDisk() {
    try {
      const raw = await readFile(this._cachePath, 'utf-8');
      const data = JSON.parse(raw);

      if (data && typeof data === 'object') {
        for (const [key, entry] of Object.entries(data) as [string, any][]) {
          if (entry?.children && entry?.fetchedAt) {
            this._memory.set(key, entry);
            // Register titles from disk cache
            for (const child of entry.children) {
              if (child.title) setCpcTitle(child.code, child.title ?? child.code);
            }
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  /** @private */
  async _saveToDisk() {
    try {
      const data = Object.fromEntries(this._memory.entries());
      await mkdir(dirname(this._cachePath), { recursive: true });
      await writeFile(this._cachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Disk write failed — non-critical
    }
  }

  /** Clear all cached entries (memory + disk + title store). */
  async clear() {
    this._memory.clear();
    _titleStore.clear();
    try {
      await writeFile(this._cachePath, '{}', 'utf-8');
    } catch { /* ignore */ }
  }

  /** Get the number of cached entries. */
  get size() {
    return this._memory.size;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a CpcTaxonomyCache with BigQuery client from environment.
 * @param {Object} [options]
 * @returns {Promise<CpcTaxonomyCache>}
 */
export async function createTaxonomyCache(options: { cachePath?: string; ttlMs?: number } = {}) {
  try {
    const { resolveConfig, getClient, defaultQueryOptions } = await import('../../../lib/patent/bigquery-client.mjs');
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
    return new CpcTaxonomyCache({
      cachePath: options.cachePath,
      ttlMs: options.ttlMs,
    });
  }
}
