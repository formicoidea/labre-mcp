// BigQuery implementation of PatentDataSource interface.
//
// Architecture:
//   SQL Query Templates (parameterized, @named_params)
//     -> Query Builder (constructs per-indicator queries from CPC codes)
//       -> BigQueryPatentSource (executes queries + transforms rows)
//         -> PatentData (canonical shape consumed by patent-indicators.mjs)
//
// All SQL uses BigQuery Standard SQL with named parameters to prevent
// injection. CPC codes are passed as ARRAY<STRING> via @cpc_codes.
//
// The query builder is the core deliverable: 8 indicator-specific SQL
// templates, each returning exactly the fields needed by the corresponding
// pure-function indicator in patent-indicators.mjs.
//
// Required: bigquery-client.mjs for client config and authentication.
// Required: patent-data-source.mjs for PatentDataSource base class + PatentData shape.
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
import { logDebug, logWarning, logError } from '../mcp-notifications.mjs';

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

// ─── Query context typedef ──────────────────────────────────────────────────

/**
 * Shared context for all query builder functions.
 *
 * @typedef {Object} QueryContext
 * @property {string}   dataset     - Fully-qualified BigQuery dataset (e.g. 'patents-public-data')
 * @property {string[]} cpcCodes    - 4-char CPC subclass codes (e.g. ['G06F', 'H04L'])
 * @property {number}   minYear     - Minimum filing year filter (default: 2000)
 * @property {number}   maxPatents  - Maximum patents to scan per query (default: 100,000)
 */

/**
 * Built query ready for BigQuery execution via client.query().
 *
 * @typedef {Object} BuiltQuery
 * @property {string} sql    - Parameterized SQL string (uses @named_params)
 * @property {Object} params - Named parameter values (e.g. { cpc_codes: ['G06F'] })
 * @property {Object} types  - BigQuery parameter type declarations
 * @property {string} name   - Human-readable query name (for logging/tracing)
 */

// ─── Query context factory ──────────────────────────────────────────────────

/**
 * Create a QueryContext from CPC codes and optional overrides.
 *
 * @param {string[]} cpcCodes - Array of CPC codes (4-char subclass or more specific prefixes)
 * @param {Object}   [options]
 * @param {string}   [options.dataset]    - BigQuery dataset override
 * @param {number}   [options.minYear]    - Minimum filing year
 * @param {number}   [options.maxPatents] - Maximum patents per query
 * @returns {QueryContext}
 */
export function createQueryContext(cpcCodes, options = {}) {
  if (!Array.isArray(cpcCodes) || cpcCodes.length === 0) {
    throw new Error('cpcCodes must be a non-empty array of CPC codes');
  }

  // Validate each code: must start with valid CPC subclass (A-H + 2 digits + letter)
  // Accepts variable-length codes: G06F, G06F9/, G06F9/455, etc.
  for (const code of cpcCodes) {
    if (!/^[A-H]\d{2}[A-Z]/.test(code)) {
      throw new Error(
        `Invalid CPC code "${code}": must start with a valid subclass (e.g. G06F, G06F9/, G06F9/455)`
      );
    }
  }

  return {
    dataset: options.dataset || 'patents-public-data',
    cpcCodes: [...cpcCodes],
    minYear: options.minYear ?? DEFAULT_MIN_YEAR,
    maxPatents: options.maxPatents ?? DEFAULT_MAX_PATENTS,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQL QUERY TEMPLATES — 8 indicator queries (parameterized)
//
// Each function returns a BuiltQuery { sql, params, types, name }.
//
// Common pattern:
//   - Filter publications by CPC prefix: EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) p WHERE STARTS_WITH(cpc_code.code, p))
//   - Filter by filing year: CAST(FLOOR(filing_date / 10000) AS INT64) >= @min_year
//   - filing_date is INT64 in YYYYMMDD format (e.g. 20150115)
//   - CPC codes are REPEATED RECORD with .code STRING (e.g. "G06F  16/00")
//
// Queries are designed to run independently and in parallel.
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. CPC Distribution (-> convergenceHHI) ─────────────────────────────────

/**
 * Build query for CPC subclass patent count distribution.
 *
 * Returns one row per CPC subclass code found across patents matching the
 * input CPC codes, with the count of distinct publications in each subclass.
 * This feeds the HHI concentration metric in convergenceHHI().
 *
 * Result columns: cpc (STRING), count (INT64)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildCpcDistributionQuery(ctx) {
  const sql = `
    -- Indicator 1: CPC subclass distribution -> convergenceHHI (certitude)
    -- Returns patent counts per 4-char CPC subclass for HHI concentration analysis
    SELECT
      SUBSTR(cpc_code.code, 1, 4) AS cpc,
      COUNT(DISTINCT p.publication_number) AS count
    FROM
      \`${ctx.dataset}.patents.publications\` p,
      UNNEST(p.cpc) AS cpc_code
    WHERE
      EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
      AND p.filing_date > 0
      AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
    GROUP BY cpc
    ORDER BY count DESC
    LIMIT 200
  `;

  return {
    sql,
    params: { cpc_codes: ctx.cpcCodes, min_year: ctx.minYear },
    types: { cpc_codes: ['STRING'], min_year: 'INT64' },
    name: 'cpc-distribution',
  };
}

// ── 2. Yearly Classifications (-> stabiliteTaxonomique) ─────────────────────

/**
 * Build query for year-over-year CPC classification snapshots.
 *
 * Returns one row per filing year, each containing an array of distinct CPC
 * subclass codes used in patents filed that year. This feeds the Jaccard
 * stability metric in stabiliteTaxonomique().
 *
 * Result columns: year (INT64), cpc_codes (ARRAY<STRING>)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildYearlyClassificationsQuery(ctx) {
  const sql = `
    -- Indicator 2: Yearly CPC classification snapshots -> stabiliteTaxonomique (certitude)
    -- Returns distinct CPC subclasses per filing year for Jaccard stability analysis
    WITH filtered_patents AS (
      SELECT DISTINCT
        p.publication_number,
        CAST(FLOOR(p.filing_date / 10000) AS INT64) AS filing_year,
        SUBSTR(cpc_code.code, 1, 4) AS cpc_subclass
      FROM
        \`${ctx.dataset}.patents.publications\` p,
        UNNEST(p.cpc) AS cpc_code
      WHERE
        EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
        AND p.filing_date > 0
        AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
    )
    SELECT
      filing_year AS year,
      ARRAY_AGG(DISTINCT cpc_subclass ORDER BY cpc_subclass) AS cpc_codes
    FROM filtered_patents
    GROUP BY filing_year
    ORDER BY filing_year
  `;

  return {
    sql,
    params: { cpc_codes: ctx.cpcCodes, min_year: ctx.minYear },
    types: { cpc_codes: ['STRING'], min_year: 'INT64' },
    name: 'yearly-classifications',
  };
}

// ── 3. Citation Data (-> densiteCitation) ───────────────────────────────────

/**
 * Build query for forward citation density.
 *
 * Counts how many times patents in the target CPC class are cited by other
 * patents (forward citations). Uses a self-join via the citation array.
 * Includes cost controls via LIMIT on the target patent set.
 *
 * Result columns: patent_count (INT64), total_forward_citations (INT64)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildCitationDataQuery(ctx) {
  const sql = `
    -- Indicator 3: Forward citation density -> densiteCitation (certitude)
    -- Counts forward citations received by patents in the target CPC class
    WITH target_patents AS (
      -- Identify all publications in the target CPC subclass(es)
      SELECT DISTINCT p.publication_number
      FROM
        \`${ctx.dataset}.patents.publications\` p,
        UNNEST(p.cpc) AS cpc_code
      WHERE
        EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
        AND p.filing_date > 0
        AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
      LIMIT @max_patents
    ),
    forward_citations AS (
      -- Count citations TO target patents FROM any other publication
      SELECT
        cite.publication_number AS cited_patent,
        COUNT(*) AS citation_count
      FROM
        \`${ctx.dataset}.patents.publications\` citing,
        UNNEST(citing.citation) AS cite
      WHERE
        cite.publication_number IN (SELECT publication_number FROM target_patents)
      GROUP BY cited_patent
    )
    SELECT
      (SELECT COUNT(*) FROM target_patents) AS patent_count,
      COALESCE(SUM(fc.citation_count), 0) AS total_forward_citations
    FROM forward_citations fc
  `;

  return {
    sql,
    params: {
      cpc_codes: ctx.cpcCodes,
      min_year: ctx.minYear,
      max_patents: ctx.maxPatents,
    },
    types: {
      cpc_codes: ['STRING'],
      min_year: 'INT64',
      max_patents: 'INT64',
    },
    name: 'citation-data',
  };
}

// ── 4. Claims Timeline (-> retrecissementClaims) ────────────────────────────

/**
 * Build query for independent claims narrowing analysis.
 *
 * Estimates the average number of independent claims per patent per filing year.
 * Independent claims are identified by regex: numbered claims (N.) in English
 * claims text that do NOT contain dependent-claim phrases like "of claim N".
 *
 * Approximation: total claim count minus dependent claim references.
 * Patent offices vary in formatting, so this is a best-effort estimate.
 *
 * Result columns: year (INT64), avg_independent_claims (FLOAT64)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildClaimsTimelineQuery(ctx) {
  const sql = `
    -- Indicator 4: Claims narrowing over time -> retrecissementClaims (certitude)
    -- Estimates average independent claims per patent per filing year
    -- Independent claims = total numbered claims - dependent claims
    WITH patent_claims AS (
      SELECT
        p.publication_number,
        CAST(FLOOR(p.filing_date / 10000) AS INT64) AS filing_year,
        -- Total claims: count patterns like "1. ", "2. " etc. at line boundaries
        ARRAY_LENGTH(
          REGEXP_EXTRACT_ALL(claims.text, r'(?m)(?:^|\\n)\\s*\\d+\\.\\s')
        ) AS total_claims,
        -- Dependent claims: reference other claims ("of claim N", "according to claim N")
        ARRAY_LENGTH(
          REGEXP_EXTRACT_ALL(claims.text, r'(?i)(?:of|to|in|according to|as (?:recited|claimed|defined|set forth) in)\\s+claims?\\s+\\d+')
        ) AS dependent_claims
      FROM
        \`${ctx.dataset}.patents.publications\` p,
        UNNEST(p.cpc) AS cpc_code,
        UNNEST(p.claims_localized) AS claims
      WHERE
        EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
        AND p.filing_date > 0
        AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
        AND claims.language = 'en'
    )
    SELECT
      filing_year AS year,
      AVG(GREATEST(total_claims - dependent_claims, 1)) AS avg_independent_claims
    FROM patent_claims
    WHERE total_claims > 0
    GROUP BY filing_year
    ORDER BY filing_year
  `;

  return {
    sql,
    params: { cpc_codes: ctx.cpcCodes, min_year: ctx.minYear },
    types: { cpc_codes: ['STRING'], min_year: 'INT64' },
    name: 'claims-timeline',
  };
}

// ── 5. Assignee Data (-> diversiteAssignees) ────────────────────────────────

/**
 * Build query for assignee (patent holder) diversity.
 *
 * Counts distinct assignee names and total patent publications in the target
 * CPC class. Uses the assignee_harmonized field for cleaned company names.
 *
 * Result columns: unique_assignees (INT64), total_patents (INT64)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildAssigneeDataQuery(ctx) {
  const sql = `
    -- Indicator 5: Assignee diversity -> diversiteAssignees (ubiquity)
    -- Counts unique patent assignees (holders) in the target CPC class
    WITH target_patents AS (
      SELECT DISTINCT
        p.publication_number,
        assignee.name AS assignee_name
      FROM
        \`${ctx.dataset}.patents.publications\` p,
        UNNEST(p.cpc) AS cpc_code,
        UNNEST(p.assignee_harmonized) AS assignee
      WHERE
        EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
        AND p.filing_date > 0
        AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
        AND assignee.name IS NOT NULL
        AND assignee.name != ''
    )
    SELECT
      COUNT(DISTINCT assignee_name) AS unique_assignees,
      COUNT(DISTINCT publication_number) AS total_patents
    FROM target_patents
  `;

  return {
    sql,
    params: { cpc_codes: ctx.cpcCodes, min_year: ctx.minYear },
    types: { cpc_codes: ['STRING'], min_year: 'INT64' },
    name: 'assignee-data',
  };
}

// ── 6. Geographic Data (-> couvertureGeo) ───────────────────────────────────

/**
 * Build query for geographic filing coverage.
 *
 * Counts distinct jurisdiction (country) codes where patents in the target
 * CPC class have been filed. Also returns the list of jurisdictions for
 * optional analysis.
 *
 * Result columns: jurisdiction_count (INT64), jurisdictions (ARRAY<STRING>)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildGeoDataQuery(ctx) {
  const sql = `
    -- Indicator 6: Geographic filing breadth -> couvertureGeo (ubiquity)
    -- Counts distinct filing jurisdictions for patents in the target CPC class
    WITH geo_patents AS (
      SELECT DISTINCT
        p.country_code
      FROM
        \`${ctx.dataset}.patents.publications\` p,
        UNNEST(p.cpc) AS cpc_code
      WHERE
        EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
        AND p.filing_date > 0
        AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
        AND p.country_code IS NOT NULL
        AND p.country_code != ''
    )
    SELECT
      COUNT(*) AS jurisdiction_count,
      ARRAY_AGG(country_code ORDER BY country_code) AS jurisdictions
    FROM geo_patents
  `;

  return {
    sql,
    params: { cpc_codes: ctx.cpcCodes, min_year: ctx.minYear },
    types: { cpc_codes: ['STRING'], min_year: 'INT64' },
    name: 'geo-data',
  };
}

// ── 7. Sector Data (-> diffusionSectorielle) ───────────────────────────────

/**
 * Build query for cross-sector CPC diffusion analysis.
 *
 * Counts distinct CPC sections (A-H, Y — first character) and CPC main
 * classes (first 3 characters, e.g. G06, H04) across all patents that share
 * at least one CPC code with the target subclass. This measures how broadly
 * the technology diffuses across different industrial sectors.
 *
 * Result columns: unique_sections (INT64), unique_classes (INT64)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildSectorDataQuery(ctx) {
  const sql = `
    -- Indicator 7: Cross-sector CPC diffusion -> diffusionSectorielle (ubiquity)
    -- Counts distinct CPC sections and main classes across co-classified patents
    WITH target_publications AS (
      -- Find all publications that have at least one CPC code in target subclass
      SELECT DISTINCT p.publication_number
      FROM
        \`${ctx.dataset}.patents.publications\` p,
        UNNEST(p.cpc) AS cpc_code
      WHERE
        EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
        AND p.filing_date > 0
        AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
      LIMIT @max_patents
    ),
    all_cpc_codes AS (
      -- Gather ALL CPC codes from those publications (not just target ones)
      SELECT DISTINCT
        SUBSTR(cpc_code.code, 1, 1) AS cpc_section,
        SUBSTR(cpc_code.code, 1, 3) AS cpc_class
      FROM
        \`${ctx.dataset}.patents.publications\` p,
        UNNEST(p.cpc) AS cpc_code
      WHERE
        p.publication_number IN (SELECT publication_number FROM target_publications)
        AND LENGTH(cpc_code.code) >= 3
    )
    SELECT
      COUNT(DISTINCT cpc_section) AS unique_sections,
      COUNT(DISTINCT cpc_class) AS unique_classes
    FROM all_cpc_codes
  `;

  return {
    sql,
    params: {
      cpc_codes: ctx.cpcCodes,
      min_year: ctx.minYear,
      max_patents: ctx.maxPatents,
    },
    types: {
      cpc_codes: ['STRING'],
      min_year: 'INT64',
      max_patents: 'INT64',
    },
    name: 'sector-data',
  };
}

// ── 8. Expiration Data (-> ratioExpires) ────────────────────────────────────

/**
 * Build query for patent expiration ratio analysis.
 *
 * Classifies patents as expired or active based on the standard 20-year
 * patent term from filing date. High expiration ratio indicates mature,
 * commoditized technology.
 *
 * Note: This is a simplified model — actual patent expiration depends on
 * maintenance fee payments, jurisdiction rules, and patent type. The 20-year
 * term from filing is the standard US/EP/PCT baseline.
 *
 * Result columns: expired_count (INT64), total_patents (INT64)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildExpirationDataQuery(ctx) {
  const sql = `
    -- Indicator 8: Patent expiration ratio -> ratioExpires (ubiquity)
    -- Classifies patents as expired (filing + 20yr <= current year) vs active
    WITH target_patents AS (
      SELECT DISTINCT
        p.publication_number,
        CAST(FLOOR(p.filing_date / 10000) AS INT64) AS filing_year
      FROM
        \`${ctx.dataset}.patents.publications\` p,
        UNNEST(p.cpc) AS cpc_code
      WHERE
        EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
        AND p.filing_date > 0
        AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
    )
    SELECT
      COUNT(*) AS total_patents,
      COUNTIF(filing_year + @patent_term <= EXTRACT(YEAR FROM CURRENT_DATE())) AS expired_count
    FROM target_patents
  `;

  return {
    sql,
    params: {
      cpc_codes: ctx.cpcCodes,
      min_year: ctx.minYear,
      patent_term: PATENT_TERM_YEARS,
    },
    types: {
      cpc_codes: ['STRING'],
      min_year: 'INT64',
      patent_term: 'INT64',
    },
    name: 'expiration-data',
  };
}

// ── Total patent count (shared baseline) ────────────────────────────────────

/**
 * Build query for total patent count in the target CPC class.
 * Used for data quality assessment in the confidence model.
 *
 * Result columns: total_patents (INT64)
 *
 * @param {QueryContext} ctx
 * @returns {BuiltQuery}
 */
export function buildTotalPatentsQuery(ctx) {
  const sql = `
    -- Baseline: total patent count for data quality assessment
    SELECT
      COUNT(DISTINCT p.publication_number) AS total_patents
    FROM
      \`${ctx.dataset}.patents.publications\` p,
      UNNEST(p.cpc) AS cpc_code
    WHERE
      EXISTS (SELECT 1 FROM UNNEST(@cpc_codes) AS p WHERE STARTS_WITH(cpc_code.code, p))
      AND p.filing_date > 0
      AND CAST(FLOOR(p.filing_date / 10000) AS INT64) >= @min_year
  `;

  return {
    sql,
    params: { cpc_codes: ctx.cpcCodes, min_year: ctx.minYear },
    types: { cpc_codes: ['STRING'], min_year: 'INT64' },
    name: 'total-patents',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY BUILDER — composes all indicator queries for a given CPC code set
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map of indicator keys to their query builder functions.
 * Used by buildAllQueries() to construct the full query set.
 * Keys match the PatentData field names in patent-data-source.mjs.
 *
 * @type {Record<string, (ctx: QueryContext) => BuiltQuery>}
 */
export const QUERY_BUILDERS = {
  cpcDistribution:       buildCpcDistributionQuery,
  yearlyClassifications: buildYearlyClassificationsQuery,
  citationData:          buildCitationDataQuery,
  claimsTimeline:        buildClaimsTimelineQuery,
  assigneeData:          buildAssigneeDataQuery,
  geoData:               buildGeoDataQuery,
  sectorData:            buildSectorDataQuery,
  expirationData:        buildExpirationDataQuery,
};

/**
 * Build all 8 indicator queries plus the total patents baseline query.
 *
 * Returns a map of query name -> BuiltQuery, ready for parallel execution.
 * Individual queries can be omitted by passing an `exclude` set (useful
 * when indicators are disabled via toggles).
 *
 * @param {string[]} cpcCodes  - 4-char CPC subclass codes (e.g. ['G06F', 'H04L'])
 * @param {Object}   [options]
 * @param {string}   [options.dataset]    - BigQuery dataset override
 * @param {number}   [options.minYear]    - Minimum filing year (default: 2000)
 * @param {number}   [options.maxPatents] - Max patents per query (default: 100,000)
 * @param {Set<string>} [options.exclude] - Set of indicator keys to skip
 * @returns {Record<string, BuiltQuery>} Map of query name -> built query
 */
export function buildAllQueries(cpcCodes, options = {}) {
  const ctx = createQueryContext(cpcCodes, options);
  const exclude = options.exclude || new Set();

  const queries = {};

  // Always include total patents baseline (needed for confidence model)
  queries.totalPatents = buildTotalPatentsQuery(ctx);

  // Build each indicator query unless excluded
  for (const [key, builder] of Object.entries(QUERY_BUILDERS)) {
    if (!exclude.has(key)) {
      queries[key] = builder(ctx);
    }
  }

  return queries;
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
