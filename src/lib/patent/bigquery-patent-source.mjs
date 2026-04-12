// BigQuery implementation of PatentDataSource interface.
//
// Architecture:
//   SQL Query Templates (in bigquery-query-builders.mjs)
//     -> BigQueryPatentSource (executes queries + transforms rows)
//       -> PatentData (canonical shape consumed by patent-indicators.mjs)
//
// All SQL uses BigQuery Standard SQL with named parameters to prevent
// injection. CPC codes are passed as ARRAY<STRING> via @cpc_codes.
//
// Required: bigquery-client.mjs for client config and authentication.
// Required: patent-data-source.mjs for PatentDataSource base class + PatentData shape.
// Required: bigquery-query-builders.mjs for SQL query construction.
//
// Dataset: Google Patents Public Data (patents-public-data.patents.publications)
// Schema reference: https://console.cloud.google.com/bigquery?p=patents-public-data

import { PatentDataSource, emptyPatentData } from './patent-data-source.mjs';
import {
  resolveConfig,
  getClient,
  defaultQueryOptions,
  checkEnvironment,
} from './bigquery-client.mjs';
import { logDebug, logWarning, logError } from '../../lib/mcp-notifications.mjs';

// Query builders extracted to bigquery-query-builders.mjs — re-export for backward compat
export {
  createQueryContext,
  buildCpcDistributionQuery,
  buildYearlyClassificationsQuery,
  buildCitationDataQuery,
  buildClaimsTimelineQuery,
  buildAssigneeDataQuery,
  buildGeoDataQuery,
  buildSectorDataQuery,
  buildExpirationDataQuery,
  buildTotalPatentsQuery,
  QUERY_BUILDERS,
  buildAllQueries,
} from './bigquery-query-builders.mjs';

import { buildAllQueries } from './bigquery-query-builders.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default minimum filing year — limits scan size and cost. */
export const DEFAULT_MIN_YEAR = 2000;

/** Maximum patent families to scan per query (cost control). */
export const DEFAULT_MAX_PATENTS = 100_000;

/**
 * Patent term in years (US post-1995 = 20 years from filing).
 * Used by the expiration query to classify expired vs active patents.
 */
export const PATENT_TERM_YEARS = 20;

// ─── Retry configuration ───────────────────────────────────────────────────

/** Default number of retry attempts for transient BigQuery errors. */
export const DEFAULT_MAX_RETRIES = 3;

/** Default base delay in ms for exponential backoff (doubles each retry). */
export const DEFAULT_BASE_DELAY_MS = 1000;

/** Maximum backoff delay cap in ms (prevents excessive waits). */
export const MAX_BACKOFF_MS = 30_000;

// ─── Error classification ──────────────────────────────────────────────────

/**
 * HTTP status codes and error patterns that indicate transient/retryable failures.
 * BigQuery-specific error codes and generic network errors.
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const RETRYABLE_ERROR_PATTERNS = [
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EPIPE/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /network/i,
  /rate limit/i,
  /too many requests/i,
  /internal error/i,
  /service unavailable/i,
  /backend error/i,
  /quota exceeded/i,
  /timeout/i,
  /AbortError/i,
];

/**
 * Classify whether a BigQuery error is transient and safe to retry.
 *
 * Retryable conditions:
 *   - HTTP 429 (rate limit), 500/502/503/504 (server errors)
 *   - Network errors (ETIMEDOUT, ECONNRESET, EAI_AGAIN, etc.)
 *   - Timeout/AbortError
 *   - BigQuery quota exceeded (temporary)
 *
 * Non-retryable (permanent):
 *   - HTTP 400 (bad request — query syntax error)
 *   - HTTP 401/403 (auth/permission — won't change on retry)
 *   - HTTP 404 (dataset/table not found)
 *   - Invalid configuration errors
 *
 * @param {Error} error - The error to classify
 * @returns {boolean} true if the error is transient and should be retried
 */
export function isRetryableError(error) {
  if (!error) return false;

  // Check HTTP status code if available (BigQuery errors often have .code or .status)
  const status = error.code || error.status || error.statusCode;
  if (typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  // Check error message against known retryable patterns
  const message = String(error.message || '');
  const name = String(error.name || '');
  const combined = `${name} ${message}`;

  return RETRYABLE_ERROR_PATTERNS.some(pattern => pattern.test(combined));
}

/**
 * Execute an async function with exponential backoff retry for transient errors.
 *
 * Retry strategy:
 *   - Base delay doubles each attempt: 1s, 2s, 4s, 8s, ...
 *   - Jitter: ±25% randomization to prevent thundering herd
 *   - Max backoff cap: 30 seconds
 *   - Only retries errors classified as transient by isRetryableError()
 *   - Non-retryable errors are thrown immediately
 *
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3] - Maximum retry attempts (0 = no retries)
 * @param {number} [options.baseDelayMs=1000] - Initial backoff delay in ms
 * @param {string} [options.label='query'] - Human-readable label for log messages
 * @returns {Promise<T>} Result of the function
 * @throws {Error} The last error if all retries are exhausted, or non-retryable error immediately
 * @template T
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    label = 'query',
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry non-transient errors
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry if we've exhausted all attempts
      if (attempt >= maxRetries) {
        break;
      }

      // Exponential backoff with jitter (±25%)
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1); // ±25%
      const delay = Math.min(exponentialDelay + jitter, MAX_BACKOFF_MS);

      logWarning(
        'BigQueryPatentSource',
        `Retrying "${label}" (attempt ${attempt + 1}/${maxRetries}) ` +
        `after ${Math.round(delay)}ms — ${error.message}`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT TRANSFORMERS — map BigQuery rows to PatentData shape
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Transform BigQuery rows from cpc-distribution query to CpcDistributionEntry[].
 * @param {Object[]} rows - BigQuery result rows
 * @returns {Array<{cpc: string, count: number}>}
 */
export function transformCpcDistribution(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => r.cpc && typeof r.count === 'number')
    .map(r => ({ cpc: String(r.cpc), count: Number(r.count) }));
}

/**
 * Transform BigQuery rows from yearly-classifications query to YearlyClassification[].
 * @param {Object[]} rows - BigQuery result rows
 * @returns {Array<{year: number, cpcCodes: string[]}>}
 */
export function transformYearlyClassifications(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => typeof r.year === 'number')
    .map(r => ({
      year: Number(r.year),
      cpcCodes: Array.isArray(r.cpc_codes) ? r.cpc_codes.map(String) : [],
    }));
}

/**
 * Transform BigQuery rows from citation-data query to CitationData.
 * @param {Object[]} rows - BigQuery result rows (single row expected)
 * @returns {{totalForwardCitations: number, patentCount: number}}
 */
export function transformCitationData(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { totalForwardCitations: 0, patentCount: 0 };
  }
  const row = rows[0];
  return {
    totalForwardCitations: Number(row.total_forward_citations || 0),
    patentCount: Number(row.patent_count || 0),
  };
}

/**
 * Transform BigQuery rows from claims-timeline query to ClaimsTimelineEntry[].
 * @param {Object[]} rows - BigQuery result rows
 * @returns {Array<{year: number, avgIndependentClaims: number}>}
 */
export function transformClaimsTimeline(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => typeof r.year === 'number' && typeof r.avg_independent_claims === 'number')
    .map(r => ({
      year: Number(r.year),
      avgIndependentClaims: Number(r.avg_independent_claims),
    }));
}

/**
 * Transform BigQuery rows from assignee-data query to AssigneeData.
 * @param {Object[]} rows - BigQuery result rows (single row expected)
 * @returns {{uniqueAssignees: number, totalPatents: number}}
 */
export function transformAssigneeData(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { uniqueAssignees: 0, totalPatents: 0 };
  }
  const row = rows[0];
  return {
    uniqueAssignees: Number(row.unique_assignees || 0),
    totalPatents: Number(row.total_patents || 0),
  };
}

/**
 * Transform BigQuery rows from geo-data query to GeoData.
 * @param {Object[]} rows - BigQuery result rows (single row expected)
 * @returns {{jurisdictionCount: number, jurisdictions: string[]}}
 */
export function transformGeoData(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { jurisdictionCount: 0, jurisdictions: [] };
  }
  const row = rows[0];
  return {
    jurisdictionCount: Number(row.jurisdiction_count || 0),
    jurisdictions: Array.isArray(row.jurisdictions) ? row.jurisdictions.map(String) : [],
  };
}

/**
 * Transform BigQuery rows from sector-data query to SectorData.
 * @param {Object[]} rows - BigQuery result rows (single row expected)
 * @returns {{uniqueSections: number, uniqueClasses: number}}
 */
export function transformSectorData(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { uniqueSections: 0, uniqueClasses: 0 };
  }
  const row = rows[0];
  return {
    uniqueSections: Number(row.unique_sections || 0),
    uniqueClasses: Number(row.unique_classes || 0),
  };
}

/**
 * Transform BigQuery rows from expiration-data query to ExpirationData.
 * @param {Object[]} rows - BigQuery result rows (single row expected)
 * @returns {{expiredCount: number, totalPatents: number}}
 */
export function transformExpirationData(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { expiredCount: 0, totalPatents: 0 };
  }
  const row = rows[0];
  return {
    expiredCount: Number(row.expired_count || 0),
    totalPatents: Number(row.total_patents || 0),
  };
}

/**
 * Map of indicator keys to their result transformer functions.
 * Keys match QUERY_BUILDERS and PatentData fields.
 *
 * @type {Record<string, (rows: Object[]) => *>}
 */
export const RESULT_TRANSFORMERS = {
  cpcDistribution:       transformCpcDistribution,
  yearlyClassifications: transformYearlyClassifications,
  citationData:          transformCitationData,
  claimsTimeline:        transformClaimsTimeline,
  assigneeData:          transformAssigneeData,
  geoData:               transformGeoData,
  sectorData:            transformSectorData,
  expirationData:        transformExpirationData,
};

// ═══════════════════════════════════════════════════════════════════════════════
// BigQueryPatentSource — PatentDataSource implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BigQuery-backed implementation of PatentDataSource.
 *
 * Executes the 8 indicator SQL queries in parallel against the Google Patents
 * Public Dataset, transforms the results into the canonical PatentData shape,
 * and returns it for consumption by patent-indicators.mjs.
 *
 * @extends PatentDataSource
 *
 * @example
 *   const source = new BigQueryPatentSource({ projectId: 'my-gcp-project' });
 *   const data = await source.fetchByCpc(['G06F', 'H04L']);
 *   // data: PatentData with all 8 indicator fields populated
 *
 * @example
 *   // Using factory function (resolves config from env):
 *   const source = createPatentSource();
 *   const data = await source.fetchByCpc(['H04W']);
 */
export class BigQueryPatentSource extends PatentDataSource {

  /**
   * @param {Object} [options]
   * @param {string} [options.projectId]   - GCP project ID (or env: BIGQUERY_PROJECT_ID)
   * @param {string} [options.keyFilename] - Service account key path (or env: GOOGLE_APPLICATION_CREDENTIALS)
   * @param {string} [options.dataset]     - BigQuery dataset (default: 'patents-public-data')
   * @param {number} [options.minYear]     - Minimum filing year (default: 2000)
   * @param {number} [options.maxPatents]  - Max patents per query (default: 100,000)
   * @param {Set<string>} [options.exclude] - Indicator keys to skip
   * @param {number} [options.maxRetries]  - Max retry attempts for transient errors (default: 3)
   * @param {number} [options.baseDelayMs] - Base backoff delay in ms (default: 1000)
   */
  constructor(options = {}) {
    super();
    this._config = resolveConfig(options);
    this._dataset = options.dataset || this._config.dataset;
    this._minYear = options.minYear ?? DEFAULT_MIN_YEAR;
    this._maxPatents = options.maxPatents ?? DEFAULT_MAX_PATENTS;
    this._exclude = options.exclude || new Set();
    this._maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this._baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this._client = null; // Lazy-initialized
  }

  /**
   * Get or create the BigQuery client instance.
   * @returns {Promise<Object>}
   */
  async _getClient() {
    if (!this._client) {
      this._client = await getClient(this._config);
    }
    return this._client;
  }

  /**
   * Execute a single built query against BigQuery (no retry).
   *
   * @param {BuiltQuery} builtQuery - Query object from a builder function
   * @returns {Promise<Object[]>} Array of result rows
   * @throws {Error} On query failure (auth, syntax, network, etc.)
   */
  async _executeQuery(builtQuery) {
    const client = await this._getClient();
    const queryOptions = {
      ...defaultQueryOptions(this._config),
      query: builtQuery.sql,
      params: builtQuery.params,
      types: builtQuery.types,
    };

    const [rows] = await client.query(queryOptions);
    return rows || [];
  }

  /**
   * Execute a single built query with exponential backoff retry for transient errors.
   *
   * Wraps _executeQuery() with withRetry() to handle transient BigQuery failures:
   *   - HTTP 429 (rate limit) — backed off automatically
   *   - HTTP 500/502/503/504 (server errors) — retried
   *   - Network errors (ETIMEDOUT, ECONNRESET) — retried
   *   - Non-retryable errors (400, 401, 403, 404) — thrown immediately
   *
   * @param {BuiltQuery} builtQuery - Query object from a builder function
   * @returns {Promise<Object[]>} Array of result rows
   * @throws {Error} Non-retryable error immediately, or last error after all retries exhausted
   */
  async _executeQueryWithRetry(builtQuery) {
    return withRetry(
      () => this._executeQuery(builtQuery),
      {
        maxRetries: this._maxRetries,
        baseDelayMs: this._baseDelayMs,
        label: builtQuery.name,
      }
    );
  }

  /**
   * Fetch raw patent data for the given CPC sub-class codes.
   *
   * Executes all 8 indicator queries in parallel with retry logic for transient
   * errors. Each query is independently retried up to maxRetries times with
   * exponential backoff. Queries that fail after all retries are gracefully
   * degraded to empty results, with errors tracked in the _queryErrors metadata.
   *
   * @param {string[]} cpcCodes - Array of 4-char CPC sub-class codes (e.g. ['H04L', 'G06F'])
   * @returns {Promise<import('./patent-data-source.mjs').PatentData>} Patent data with optional _queryErrors metadata
   */
  async fetchByCpc(cpcCodes) {
    if (!Array.isArray(cpcCodes) || cpcCodes.length === 0) {
      return emptyPatentData();
    }

    // Build all queries
    const queries = buildAllQueries(cpcCodes, {
      dataset: this._dataset,
      minYear: this._minYear,
      maxPatents: this._maxPatents,
      exclude: this._exclude,
    });

    // Execute all queries in parallel, each with independent retry logic
    const queryEntries = Object.entries(queries);
    const results = await Promise.allSettled(
      queryEntries.map(([, query]) => this._executeQueryWithRetry(query))
    );

    // Map results by query key, tracking errors for diagnostics
    const resultMap = {};
    const queryErrors = [];

    for (let i = 0; i < queryEntries.length; i++) {
      const [key] = queryEntries[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        resultMap[key] = result.value;
      } else {
        // Query failed after all retry attempts — graceful degradation
        resultMap[key] = [];
        const error = result.reason;
        queryErrors.push({
          query: key,
          error: error.message || String(error),
          retryable: isRetryableError(error),
        });
        logWarning(
          'BigQueryPatentSource',
          `Query "${key}" failed after retries for CPC [${cpcCodes.join(', ')}]: ${error.message}`
        );
      }
    }

    // Log aggregate error summary if any queries failed
    if (queryErrors.length > 0) {
      const total = queryEntries.length;
      const failed = queryErrors.length;
      logError(
        'BigQueryPatentSource',
        `${failed}/${total} queries failed for CPC [${cpcCodes.join(', ')}]. ` +
        `Failed: ${queryErrors.map(e => e.query).join(', ')}. ` +
        `Results may have reduced accuracy.`
      );
    } else {
      logDebug(
        'BigQueryPatentSource',
        `All ${queryEntries.length} queries succeeded for CPC [${cpcCodes.join(', ')}]`
      );
    }

    // Extract total patent count
    const totalPatentsRow = resultMap.totalPatents?.[0];
    const totalPatents = Number(totalPatentsRow?.total_patents || 0);

    // Transform each indicator's raw rows into the PatentData shape
    const patentData = {
      totalPatents,
      cpcDistribution:       RESULT_TRANSFORMERS.cpcDistribution(resultMap.cpcDistribution),
      yearlyClassifications: RESULT_TRANSFORMERS.yearlyClassifications(resultMap.yearlyClassifications),
      citationData:          RESULT_TRANSFORMERS.citationData(resultMap.citationData),
      claimsTimeline:        RESULT_TRANSFORMERS.claimsTimeline(resultMap.claimsTimeline),
      assigneeData:          RESULT_TRANSFORMERS.assigneeData(resultMap.assigneeData),
      geoData:               RESULT_TRANSFORMERS.geoData(resultMap.geoData),
      sectorData:            RESULT_TRANSFORMERS.sectorData(resultMap.sectorData),
      expirationData:        RESULT_TRANSFORMERS.expirationData(resultMap.expirationData),
    };

    // Attach error metadata for diagnostics (non-enumerable to avoid polluting serialization)
    if (queryErrors.length > 0) {
      Object.defineProperty(patentData, '_queryErrors', {
        value: queryErrors,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }

    return patentData;
  }

  /**
   * Release the BigQuery client from the pool.
   * @returns {Promise<void>}
   */
  async close() {
    if (this._config?.projectId) {
      const { destroyClient } = await import('./bigquery-client.mjs');
      destroyClient(this._config.projectId);
      this._client = null;
    }
  }
}

// ─── Factory function ───────────────────────────────────────────────────────

/**
 * Create a BigQueryPatentSource with configuration resolved from environment.
 *
 * Convenience factory that resolves config from env vars:
 *   BIGQUERY_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS, BIGQUERY_DATASET, etc.
 *
 * @param {Object} [options] - Additional options passed to BigQueryPatentSource
 * @returns {BigQueryPatentSource}
 * @throws {Error} If required env vars are missing
 */
export function createPatentSource(options = {}) {
  return new BigQueryPatentSource(options);
}
