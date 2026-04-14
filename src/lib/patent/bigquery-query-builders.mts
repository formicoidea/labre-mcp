// BigQuery SQL query builders for CPC patent indicators.
//
// Extracted from bigquery-patent-source.mjs for single-responsibility.
//
// Architecture:
//   Query Context (validated CPC codes + options)
//     -> 8 indicator-specific SQL template builders
//       -> buildAllQueries() compositor
//
// Each builder returns a BuiltQuery { sql, params, types, name }
// ready for parameterized execution via BigQuery client.query().
//
// All SQL uses BigQuery Standard SQL with named parameters (@cpc_codes, @min_year, etc.)
// to prevent injection. CPC codes are passed as ARRAY<STRING>.

import {
  DEFAULT_MIN_YEAR,
  DEFAULT_MAX_PATENTS,
  PATENT_TERM_YEARS,
} from './bigquery-patent-source.mjs';

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
export function createQueryContext(cpcCodes: string[], options: any = {}) {
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
export function buildAllQueries(cpcCodes: string[], options: any = {}) {
  const ctx = createQueryContext(cpcCodes, options);
  const exclude = options.exclude || new Set();

  const queries: Record<string, any> = {};

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
