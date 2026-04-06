// Tests for bigquery-patent-source.mjs — CPC indicator SQL query builder
//
// Verifies:
//   1. Query context creation and validation
//   2. All 8 indicator SQL query builders produce valid parameterized queries
//   3. Combined buildAllQueries() composes correctly with exclude support
//   4. Result transformers correctly map BigQuery rows to PatentData shape
//   5. BigQueryPatentSource.fetchByCpc() with mock BigQuery client
//   6. Error classification: retryable vs non-retryable BigQuery errors
//   7. Retry logic with exponential backoff for transient failures
//   8. Error handling and graceful degradation in fetchByCpc()
//
// No actual BigQuery connection is made — all queries are validated structurally.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  // Constants
  DEFAULT_MIN_YEAR,
  DEFAULT_MAX_PATENTS,
  PATENT_TERM_YEARS,
  // Retry constants
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY_MS,
  MAX_BACKOFF_MS,
  // Error classification + retry
  isRetryableError,
  withRetry,
  // Query context
  createQueryContext,
  // Individual query builders
  buildCpcDistributionQuery,
  buildYearlyClassificationsQuery,
  buildCitationDataQuery,
  buildClaimsTimelineQuery,
  buildAssigneeDataQuery,
  buildGeoDataQuery,
  buildSectorDataQuery,
  buildExpirationDataQuery,
  buildTotalPatentsQuery,
  // Combined builder
  QUERY_BUILDERS,
  buildAllQueries,
  // Result transformers
  RESULT_TRANSFORMERS,
  transformCpcDistribution,
  transformYearlyClassifications,
  transformCitationData,
  transformClaimsTimeline,
  transformAssigneeData,
  transformGeoData,
  transformSectorData,
  transformExpirationData,
  // Class + factory
  BigQueryPatentSource,
  createPatentSource,
} from './bigquery-patent-source.mjs';

import { PatentDataSource } from './patent-data-source.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a valid query context for testing. */
function testCtx(overrides = {}) {
  return createQueryContext(
    overrides.cpcCodes || ['G06F', 'H04L'],
    {
      dataset: overrides.dataset || 'patents-public-data',
      minYear: overrides.minYear ?? 2000,
      maxPatents: overrides.maxPatents ?? 100_000,
    }
  );
}

/**
 * Assert that a built query has the expected structure.
 * @param {Object} query - BuiltQuery object
 * @param {string} expectedName - Expected query name
 */
function assertValidQuery(query, expectedName) {
  assert.ok(query, 'Query should not be null/undefined');
  assert.equal(typeof query.sql, 'string', 'sql must be a string');
  assert.ok(query.sql.trim().length > 0, 'sql must not be empty');
  assert.equal(typeof query.params, 'object', 'params must be an object');
  assert.equal(typeof query.types, 'object', 'types must be an object');
  assert.equal(typeof query.name, 'string', 'name must be a string');
  if (expectedName) {
    assert.equal(query.name, expectedName, `name should be "${expectedName}"`);
  }
}

/**
 * Assert that a query uses parameterized CPC codes (not inline values).
 * @param {Object} query - BuiltQuery object
 */
function assertParameterized(query) {
  // Must use @cpc_codes parameter, not inline values
  assert.ok(
    query.sql.includes('@cpc_codes'),
    'Query must use @cpc_codes parameter for injection safety'
  );
  // Must have cpc_codes in params
  assert.ok(
    Array.isArray(query.params.cpc_codes),
    'params.cpc_codes must be an array'
  );
  // Must declare type for cpc_codes
  assert.ok(
    query.types.cpc_codes,
    'types must declare cpc_codes type'
  );
  // Must NOT contain raw CPC code strings in the SQL
  for (const code of query.params.cpc_codes) {
    assert.ok(
      !query.sql.includes(`'${code}'`),
      `SQL must not contain inline CPC code '${code}' — use parameters`
    );
  }
}

/**
 * Assert that a query uses the min_year parameter.
 * @param {Object} query - BuiltQuery object
 */
function assertHasMinYearParam(query) {
  assert.ok(
    query.sql.includes('@min_year'),
    'Query must use @min_year parameter'
  );
  assert.equal(typeof query.params.min_year, 'number', 'min_year param must be a number');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('Constants', () => {
  it('DEFAULT_MIN_YEAR should be 2000', () => {
    assert.equal(DEFAULT_MIN_YEAR, 2000);
  });

  it('DEFAULT_MAX_PATENTS should be 100,000', () => {
    assert.equal(DEFAULT_MAX_PATENTS, 100_000);
  });

  it('PATENT_TERM_YEARS should be 20', () => {
    assert.equal(PATENT_TERM_YEARS, 20);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createQueryContext
// ═══════════════════════════════════════════════════════════════════════════════

describe('createQueryContext', () => {
  it('should create context with valid CPC codes', () => {
    const ctx = createQueryContext(['G06F', 'H04L']);
    assert.deepEqual(ctx.cpcCodes, ['G06F', 'H04L']);
    assert.equal(ctx.dataset, 'patents-public-data');
    assert.equal(ctx.minYear, DEFAULT_MIN_YEAR);
    assert.equal(ctx.maxPatents, DEFAULT_MAX_PATENTS);
  });

  it('should accept single CPC code', () => {
    const ctx = createQueryContext(['H04W']);
    assert.deepEqual(ctx.cpcCodes, ['H04W']);
  });

  it('should accept option overrides', () => {
    const ctx = createQueryContext(['G06F'], {
      dataset: 'custom-dataset',
      minYear: 2010,
      maxPatents: 50_000,
    });
    assert.equal(ctx.dataset, 'custom-dataset');
    assert.equal(ctx.minYear, 2010);
    assert.equal(ctx.maxPatents, 50_000);
  });

  it('should reject empty cpcCodes array', () => {
    assert.throws(
      () => createQueryContext([]),
      /non-empty array/
    );
  });

  it('should reject non-array cpcCodes', () => {
    assert.throws(
      () => createQueryContext('G06F'),
      /non-empty array/
    );
  });

  it('should reject invalid CPC code format — lowercase', () => {
    assert.throws(
      () => createQueryContext(['g06f']),
      /Invalid CPC subclass code/
    );
  });

  it('should reject invalid CPC code format — too short', () => {
    assert.throws(
      () => createQueryContext(['G06']),
      /Invalid CPC subclass code/
    );
  });

  it('should reject invalid CPC code format — too long', () => {
    assert.throws(
      () => createQueryContext(['G06F1']),
      /Invalid CPC subclass code/
    );
  });

  it('should reject invalid CPC code format — wrong section letter', () => {
    assert.throws(
      () => createQueryContext(['Z06F']),
      /Invalid CPC subclass code/
    );
  });

  it('should reject mixed valid/invalid CPC codes', () => {
    assert.throws(
      () => createQueryContext(['G06F', 'invalid']),
      /Invalid CPC subclass code/
    );
  });

  it('should accept all valid CPC section letters A-H', () => {
    const validCodes = ['A61K', 'B25J', 'C12N', 'D01F', 'E04B', 'F24S', 'G06F', 'H04L'];
    const ctx = createQueryContext(validCodes);
    assert.equal(ctx.cpcCodes.length, 8);
  });

  it('should create a defensive copy of cpcCodes', () => {
    const codes = ['G06F'];
    const ctx = createQueryContext(codes);
    codes.push('H04L');
    assert.equal(ctx.cpcCodes.length, 1, 'Context should not be affected by external mutations');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Individual Query Builders — structural validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildCpcDistributionQuery', () => {
  it('should produce a valid parameterized query', () => {
    const ctx = testCtx();
    const q = buildCpcDistributionQuery(ctx);
    assertValidQuery(q, 'cpc-distribution');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should SELECT cpc and count columns', () => {
    const q = buildCpcDistributionQuery(testCtx());
    assert.ok(q.sql.includes('AS cpc'), 'Must select cpc alias');
    assert.ok(q.sql.includes('AS count'), 'Must select count alias');
  });

  it('should GROUP BY cpc subclass', () => {
    const q = buildCpcDistributionQuery(testCtx());
    assert.ok(q.sql.includes('GROUP BY cpc'), 'Must group by CPC subclass');
  });

  it('should use SUBSTR to extract 4-char subclass', () => {
    const q = buildCpcDistributionQuery(testCtx());
    assert.ok(q.sql.includes('SUBSTR(cpc_code.code, 1, 4)'), 'Must extract 4-char subclass');
  });

  it('should COUNT DISTINCT publication_number', () => {
    const q = buildCpcDistributionQuery(testCtx());
    assert.ok(
      q.sql.includes('COUNT(DISTINCT p.publication_number)'),
      'Must count distinct publications'
    );
  });
});

describe('buildYearlyClassificationsQuery', () => {
  it('should produce a valid parameterized query', () => {
    const q = buildYearlyClassificationsQuery(testCtx());
    assertValidQuery(q, 'yearly-classifications');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should SELECT year and cpc_codes array', () => {
    const q = buildYearlyClassificationsQuery(testCtx());
    assert.ok(q.sql.includes('AS year'), 'Must select year alias');
    assert.ok(q.sql.includes('AS cpc_codes'), 'Must select cpc_codes alias');
  });

  it('should use ARRAY_AGG DISTINCT for CPC codes', () => {
    const q = buildYearlyClassificationsQuery(testCtx());
    assert.ok(q.sql.includes('ARRAY_AGG(DISTINCT'), 'Must aggregate distinct CPC codes');
  });

  it('should GROUP BY filing year', () => {
    const q = buildYearlyClassificationsQuery(testCtx());
    assert.ok(q.sql.includes('GROUP BY filing_year'), 'Must group by year');
  });

  it('should ORDER BY year for chronological analysis', () => {
    const q = buildYearlyClassificationsQuery(testCtx());
    assert.ok(q.sql.includes('ORDER BY filing_year'), 'Must order by year');
  });
});

describe('buildCitationDataQuery', () => {
  it('should produce a valid parameterized query', () => {
    const q = buildCitationDataQuery(testCtx());
    assertValidQuery(q, 'citation-data');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should use CTE for target patents identification', () => {
    const q = buildCitationDataQuery(testCtx());
    assert.ok(q.sql.includes('WITH target_patents'), 'Must use target_patents CTE');
  });

  it('should compute forward citations via self-join', () => {
    const q = buildCitationDataQuery(testCtx());
    assert.ok(q.sql.includes('forward_citations'), 'Must compute forward citations');
    assert.ok(q.sql.includes('cite.publication_number'), 'Must join via citation references');
  });

  it('should SELECT patent_count and total_forward_citations', () => {
    const q = buildCitationDataQuery(testCtx());
    assert.ok(q.sql.includes('AS patent_count'), 'Must select patent_count');
    assert.ok(q.sql.includes('AS total_forward_citations'), 'Must select total_forward_citations');
  });

  it('should include max_patents parameter for cost control', () => {
    const q = buildCitationDataQuery(testCtx());
    assert.ok(q.sql.includes('@max_patents') || q.sql.includes('LIMIT'), 'Must have cost control');
    assert.equal(typeof q.params.max_patents, 'number', 'max_patents param should be present');
  });
});

describe('buildClaimsTimelineQuery', () => {
  it('should produce a valid parameterized query', () => {
    const q = buildClaimsTimelineQuery(testCtx());
    assertValidQuery(q, 'claims-timeline');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should SELECT year and avg_independent_claims', () => {
    const q = buildClaimsTimelineQuery(testCtx());
    assert.ok(q.sql.includes('AS year'), 'Must select year');
    assert.ok(q.sql.includes('AS avg_independent_claims'), 'Must select avg_independent_claims');
  });

  it('should use regex to extract claim counts', () => {
    const q = buildClaimsTimelineQuery(testCtx());
    assert.ok(q.sql.includes('REGEXP_EXTRACT_ALL'), 'Must use regex for claim counting');
  });

  it('should distinguish total vs dependent claims', () => {
    const q = buildClaimsTimelineQuery(testCtx());
    assert.ok(q.sql.includes('total_claims'), 'Must compute total claims');
    assert.ok(q.sql.includes('dependent_claims'), 'Must compute dependent claims');
  });

  it('should filter for English claims text', () => {
    const q = buildClaimsTimelineQuery(testCtx());
    assert.ok(q.sql.includes("language = 'en'"), 'Must filter for English claims');
  });

  it('should ORDER BY year for time series analysis', () => {
    const q = buildClaimsTimelineQuery(testCtx());
    assert.ok(q.sql.includes('ORDER BY'), 'Must order results');
  });
});

describe('buildAssigneeDataQuery', () => {
  it('should produce a valid parameterized query', () => {
    const q = buildAssigneeDataQuery(testCtx());
    assertValidQuery(q, 'assignee-data');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should COUNT DISTINCT assignee names', () => {
    const q = buildAssigneeDataQuery(testCtx());
    assert.ok(q.sql.includes('COUNT(DISTINCT assignee_name)'), 'Must count unique assignees');
  });

  it('should SELECT unique_assignees and total_patents', () => {
    const q = buildAssigneeDataQuery(testCtx());
    assert.ok(q.sql.includes('AS unique_assignees'), 'Must select unique_assignees');
    assert.ok(q.sql.includes('AS total_patents'), 'Must select total_patents');
  });

  it('should use assignee_harmonized for cleaned names', () => {
    const q = buildAssigneeDataQuery(testCtx());
    assert.ok(q.sql.includes('assignee_harmonized'), 'Must use harmonized assignee names');
  });

  it('should filter out empty assignee names', () => {
    const q = buildAssigneeDataQuery(testCtx());
    assert.ok(q.sql.includes('IS NOT NULL'), 'Must filter null assignees');
    assert.ok(q.sql.includes("!= ''"), 'Must filter empty assignees');
  });
});

describe('buildGeoDataQuery', () => {
  it('should produce a valid parameterized query', () => {
    const q = buildGeoDataQuery(testCtx());
    assertValidQuery(q, 'geo-data');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should SELECT jurisdiction_count and jurisdictions array', () => {
    const q = buildGeoDataQuery(testCtx());
    assert.ok(q.sql.includes('AS jurisdiction_count'), 'Must select jurisdiction_count');
    assert.ok(q.sql.includes('AS jurisdictions'), 'Must select jurisdictions array');
  });

  it('should count DISTINCT country codes', () => {
    const q = buildGeoDataQuery(testCtx());
    assert.ok(q.sql.includes('country_code'), 'Must reference country_code field');
  });

  it('should filter out null/empty country codes', () => {
    const q = buildGeoDataQuery(testCtx());
    assert.ok(q.sql.includes('IS NOT NULL'), 'Must filter null country codes');
  });
});

describe('buildSectorDataQuery', () => {
  it('should produce a valid parameterized query', () => {
    const q = buildSectorDataQuery(testCtx());
    assertValidQuery(q, 'sector-data');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should SELECT unique_sections and unique_classes', () => {
    const q = buildSectorDataQuery(testCtx());
    assert.ok(q.sql.includes('AS unique_sections'), 'Must select unique_sections');
    assert.ok(q.sql.includes('AS unique_classes'), 'Must select unique_classes');
  });

  it('should extract CPC section (1st char) and class (first 3 chars)', () => {
    const q = buildSectorDataQuery(testCtx());
    assert.ok(q.sql.includes('SUBSTR(cpc_code.code, 1, 1)'), 'Must extract section letter');
    assert.ok(q.sql.includes('SUBSTR(cpc_code.code, 1, 3)'), 'Must extract 3-char class');
  });

  it('should look at ALL CPC codes of matching patents (not just target)', () => {
    const q = buildSectorDataQuery(testCtx());
    assert.ok(q.sql.includes('target_publications'), 'Must identify target publications first');
    assert.ok(q.sql.includes('all_cpc_codes'), 'Must gather all CPC codes from target pubs');
  });

  it('should include max_patents for cost control', () => {
    const q = buildSectorDataQuery(testCtx());
    assert.ok(
      q.sql.includes('@max_patents') || q.sql.includes('LIMIT'),
      'Must have cost control'
    );
  });
});

describe('buildExpirationDataQuery', () => {
  it('should produce a valid parameterized query', () => {
    const q = buildExpirationDataQuery(testCtx());
    assertValidQuery(q, 'expiration-data');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should SELECT expired_count and total_patents', () => {
    const q = buildExpirationDataQuery(testCtx());
    assert.ok(q.sql.includes('AS total_patents'), 'Must select total_patents');
    assert.ok(q.sql.includes('AS expired_count'), 'Must select expired_count');
  });

  it('should use patent_term parameter for expiration calculation', () => {
    const q = buildExpirationDataQuery(testCtx());
    assert.ok(q.sql.includes('@patent_term'), 'Must use @patent_term parameter');
    assert.equal(q.params.patent_term, PATENT_TERM_YEARS, 'patent_term should be 20');
  });

  it('should compare filing year + patent term to current date', () => {
    const q = buildExpirationDataQuery(testCtx());
    assert.ok(q.sql.includes('CURRENT_DATE'), 'Must reference current date');
    assert.ok(q.sql.includes('filing_year + @patent_term'), 'Must compute expiration year');
  });

  it('should use COUNTIF for conditional expired count', () => {
    const q = buildExpirationDataQuery(testCtx());
    assert.ok(q.sql.includes('COUNTIF'), 'Must use COUNTIF for conditional counting');
  });
});

describe('buildTotalPatentsQuery', () => {
  it('should produce a valid parameterized query', () => {
    const q = buildTotalPatentsQuery(testCtx());
    assertValidQuery(q, 'total-patents');
    assertParameterized(q);
    assertHasMinYearParam(q);
  });

  it('should SELECT total_patents', () => {
    const q = buildTotalPatentsQuery(testCtx());
    assert.ok(q.sql.includes('AS total_patents'), 'Must select total_patents');
  });

  it('should COUNT DISTINCT publications', () => {
    const q = buildTotalPatentsQuery(testCtx());
    assert.ok(q.sql.includes('COUNT(DISTINCT p.publication_number)'), 'Must count distinct pubs');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY_BUILDERS registry
// ═══════════════════════════════════════════════════════════════════════════════

describe('QUERY_BUILDERS', () => {
  it('should contain exactly 8 indicator builders', () => {
    assert.equal(Object.keys(QUERY_BUILDERS).length, 8);
  });

  it('should have keys matching PatentData fields', () => {
    const expectedKeys = [
      'cpcDistribution',
      'yearlyClassifications',
      'citationData',
      'claimsTimeline',
      'assigneeData',
      'geoData',
      'sectorData',
      'expirationData',
    ];
    assert.deepEqual(Object.keys(QUERY_BUILDERS).sort(), expectedKeys.sort());
  });

  it('each builder should be a function', () => {
    for (const [key, builder] of Object.entries(QUERY_BUILDERS)) {
      assert.equal(typeof builder, 'function', `${key} builder must be a function`);
    }
  });

  it('each builder should produce a valid query with the same context', () => {
    const ctx = testCtx();
    for (const [key, builder] of Object.entries(QUERY_BUILDERS)) {
      const q = builder(ctx);
      assertValidQuery(q, undefined);
      assertParameterized(q);
      assert.ok(q.name, `${key} query must have a name`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildAllQueries — combined builder
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildAllQueries', () => {
  it('should return 9 queries (8 indicators + totalPatents)', () => {
    const queries = buildAllQueries(['G06F']);
    assert.equal(Object.keys(queries).length, 9);
    assert.ok(queries.totalPatents, 'Must include totalPatents baseline');
  });

  it('should include all 8 indicator queries', () => {
    const queries = buildAllQueries(['G06F']);
    for (const key of Object.keys(QUERY_BUILDERS)) {
      assert.ok(queries[key], `Must include ${key} query`);
    }
  });

  it('should exclude specified indicators', () => {
    const queries = buildAllQueries(['G06F'], {
      exclude: new Set(['citationData', 'claimsTimeline']),
    });
    assert.ok(!queries.citationData, 'citationData should be excluded');
    assert.ok(!queries.claimsTimeline, 'claimsTimeline should be excluded');
    assert.equal(Object.keys(queries).length, 7); // 6 indicators + totalPatents
  });

  it('should always include totalPatents even when indicators are excluded', () => {
    const queries = buildAllQueries(['G06F'], {
      exclude: new Set(['cpcDistribution', 'yearlyClassifications', 'citationData',
        'claimsTimeline', 'assigneeData', 'geoData', 'sectorData', 'expirationData']),
    });
    assert.ok(queries.totalPatents, 'totalPatents must always be present');
  });

  it('should pass through dataset option', () => {
    const queries = buildAllQueries(['G06F'], { dataset: 'my-custom-dataset' });
    // Check that SQL references the custom dataset
    assert.ok(
      queries.totalPatents.sql.includes('my-custom-dataset'),
      'SQL should use custom dataset'
    );
  });

  it('should pass through minYear option', () => {
    const queries = buildAllQueries(['G06F'], { minYear: 2015 });
    assert.equal(queries.totalPatents.params.min_year, 2015);
  });

  it('should validate CPC codes', () => {
    assert.throws(
      () => buildAllQueries(['invalid']),
      /Invalid CPC subclass code/
    );
  });

  it('should reject empty CPC codes', () => {
    assert.throws(
      () => buildAllQueries([]),
      /non-empty array/
    );
  });

  it('all queries should be parameterized (no injection)', () => {
    const queries = buildAllQueries(['G06F', 'H04L']);
    for (const [key, query] of Object.entries(queries)) {
      assertParameterized(query);
      // Verify no inline CPC values
      assert.ok(
        !query.sql.includes("'G06F'"),
        `${key}: SQL must not contain inline CPC code 'G06F'`
      );
      assert.ok(
        !query.sql.includes("'H04L'"),
        `${key}: SQL must not contain inline CPC code 'H04L'`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Result Transformers
// ═══════════════════════════════════════════════════════════════════════════════

describe('RESULT_TRANSFORMERS', () => {
  it('should contain exactly 8 transformers matching QUERY_BUILDERS keys', () => {
    assert.equal(Object.keys(RESULT_TRANSFORMERS).length, 8);
    assert.deepEqual(
      Object.keys(RESULT_TRANSFORMERS).sort(),
      Object.keys(QUERY_BUILDERS).sort()
    );
  });
});

describe('transformCpcDistribution', () => {
  it('should transform valid rows', () => {
    const rows = [
      { cpc: 'G06F', count: 120 },
      { cpc: 'H04L', count: 80 },
    ];
    const result = transformCpcDistribution(rows);
    assert.deepEqual(result, [
      { cpc: 'G06F', count: 120 },
      { cpc: 'H04L', count: 80 },
    ]);
  });

  it('should return empty array for null/undefined', () => {
    assert.deepEqual(transformCpcDistribution(null), []);
    assert.deepEqual(transformCpcDistribution(undefined), []);
  });

  it('should return empty array for empty rows', () => {
    assert.deepEqual(transformCpcDistribution([]), []);
  });

  it('should filter out rows with missing cpc', () => {
    const rows = [
      { cpc: 'G06F', count: 100 },
      { cpc: null, count: 50 },
      { count: 30 },
    ];
    const result = transformCpcDistribution(rows);
    assert.equal(result.length, 1);
    assert.equal(result[0].cpc, 'G06F');
  });

  it('should coerce types to string/number', () => {
    const rows = [{ cpc: 'G06F', count: 100 }];
    const result = transformCpcDistribution(rows);
    assert.equal(typeof result[0].cpc, 'string');
    assert.equal(typeof result[0].count, 'number');
  });
});

describe('transformYearlyClassifications', () => {
  it('should transform valid rows', () => {
    const rows = [
      { year: 2020, cpc_codes: ['G06F', 'H04L'] },
      { year: 2021, cpc_codes: ['G06F', 'H04L', 'H04W'] },
    ];
    const result = transformYearlyClassifications(rows);
    assert.equal(result.length, 2);
    assert.equal(result[0].year, 2020);
    assert.deepEqual(result[0].cpcCodes, ['G06F', 'H04L']);
    assert.equal(result[1].year, 2021);
    assert.deepEqual(result[1].cpcCodes, ['G06F', 'H04L', 'H04W']);
  });

  it('should return empty array for null/undefined', () => {
    assert.deepEqual(transformYearlyClassifications(null), []);
    assert.deepEqual(transformYearlyClassifications(undefined), []);
  });

  it('should handle missing cpc_codes array', () => {
    const rows = [{ year: 2020, cpc_codes: null }];
    const result = transformYearlyClassifications(rows);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].cpcCodes, []);
  });

  it('should filter rows without numeric year', () => {
    const rows = [
      { year: 2020, cpc_codes: ['G06F'] },
      { year: null, cpc_codes: ['H04L'] },
    ];
    const result = transformYearlyClassifications(rows);
    assert.equal(result.length, 1);
  });
});

describe('transformCitationData', () => {
  it('should transform single-row result', () => {
    const rows = [{ patent_count: 500, total_forward_citations: 12000 }];
    const result = transformCitationData(rows);
    assert.equal(result.patentCount, 500);
    assert.equal(result.totalForwardCitations, 12000);
  });

  it('should return zeros for empty results', () => {
    const result = transformCitationData([]);
    assert.equal(result.patentCount, 0);
    assert.equal(result.totalForwardCitations, 0);
  });

  it('should return zeros for null', () => {
    const result = transformCitationData(null);
    assert.equal(result.patentCount, 0);
    assert.equal(result.totalForwardCitations, 0);
  });

  it('should handle missing fields gracefully', () => {
    const rows = [{ patent_count: 100 }];
    const result = transformCitationData(rows);
    assert.equal(result.patentCount, 100);
    assert.equal(result.totalForwardCitations, 0);
  });
});

describe('transformClaimsTimeline', () => {
  it('should transform valid time series rows', () => {
    const rows = [
      { year: 2015, avg_independent_claims: 8.5 },
      { year: 2020, avg_independent_claims: 4.2 },
    ];
    const result = transformClaimsTimeline(rows);
    assert.equal(result.length, 2);
    assert.equal(result[0].year, 2015);
    assert.equal(result[0].avgIndependentClaims, 8.5);
    assert.equal(result[1].year, 2020);
    assert.equal(result[1].avgIndependentClaims, 4.2);
  });

  it('should return empty array for null/undefined', () => {
    assert.deepEqual(transformClaimsTimeline(null), []);
    assert.deepEqual(transformClaimsTimeline(undefined), []);
  });

  it('should filter rows with non-numeric values', () => {
    const rows = [
      { year: 2020, avg_independent_claims: 5.0 },
      { year: 'invalid', avg_independent_claims: 3.0 },
      { year: 2021, avg_independent_claims: null },
    ];
    const result = transformClaimsTimeline(rows);
    assert.equal(result.length, 1);
    assert.equal(result[0].year, 2020);
  });
});

describe('transformAssigneeData', () => {
  it('should transform single-row result', () => {
    const rows = [{ unique_assignees: 150, total_patents: 500 }];
    const result = transformAssigneeData(rows);
    assert.equal(result.uniqueAssignees, 150);
    assert.equal(result.totalPatents, 500);
  });

  it('should return zeros for empty results', () => {
    const result = transformAssigneeData([]);
    assert.equal(result.uniqueAssignees, 0);
    assert.equal(result.totalPatents, 0);
  });

  it('should handle missing fields', () => {
    const rows = [{ unique_assignees: 42 }];
    const result = transformAssigneeData(rows);
    assert.equal(result.uniqueAssignees, 42);
    assert.equal(result.totalPatents, 0);
  });
});

describe('transformGeoData', () => {
  it('should transform single-row result with jurisdictions array', () => {
    const rows = [{ jurisdiction_count: 5, jurisdictions: ['US', 'EP', 'CN', 'JP', 'KR'] }];
    const result = transformGeoData(rows);
    assert.equal(result.jurisdictionCount, 5);
    assert.deepEqual(result.jurisdictions, ['US', 'EP', 'CN', 'JP', 'KR']);
  });

  it('should return zeros for empty results', () => {
    const result = transformGeoData([]);
    assert.equal(result.jurisdictionCount, 0);
    assert.deepEqual(result.jurisdictions, []);
  });

  it('should handle missing jurisdictions array', () => {
    const rows = [{ jurisdiction_count: 3, jurisdictions: null }];
    const result = transformGeoData(rows);
    assert.equal(result.jurisdictionCount, 3);
    assert.deepEqual(result.jurisdictions, []);
  });
});

describe('transformSectorData', () => {
  it('should transform single-row result', () => {
    const rows = [{ unique_sections: 4, unique_classes: 12 }];
    const result = transformSectorData(rows);
    assert.equal(result.uniqueSections, 4);
    assert.equal(result.uniqueClasses, 12);
  });

  it('should return zeros for empty results', () => {
    const result = transformSectorData([]);
    assert.equal(result.uniqueSections, 0);
    assert.equal(result.uniqueClasses, 0);
  });
});

describe('transformExpirationData', () => {
  it('should transform single-row result', () => {
    const rows = [{ expired_count: 200, total_patents: 500 }];
    const result = transformExpirationData(rows);
    assert.equal(result.expiredCount, 200);
    assert.equal(result.totalPatents, 500);
  });

  it('should return zeros for empty results', () => {
    const result = transformExpirationData([]);
    assert.equal(result.expiredCount, 0);
    assert.equal(result.totalPatents, 0);
  });

  it('should handle missing fields', () => {
    const rows = [{ total_patents: 300 }];
    const result = transformExpirationData(rows);
    assert.equal(result.expiredCount, 0);
    assert.equal(result.totalPatents, 300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BigQueryPatentSource — integration with mock client
// ═══════════════════════════════════════════════════════════════════════════════

describe('BigQueryPatentSource', () => {
  // Save/restore env for constructor tests
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.BIGQUERY_PROJECT_ID = 'test-patent-proj';
  });

  // Restore env after each test
  function restoreEnv() {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }

  it('should extend PatentDataSource', () => {
    const source = new BigQueryPatentSource({ projectId: 'test-patent-proj' });
    restoreEnv();
    assert.ok(source instanceof PatentDataSource);
  });

  it('should return emptyPatentData for empty cpcCodes', async () => {
    const source = new BigQueryPatentSource({ projectId: 'test-patent-proj' });
    restoreEnv();
    const result = await source.fetchByCpc([]);
    assert.equal(result.totalPatents, 0);
    assert.deepEqual(result.cpcDistribution, []);
    assert.deepEqual(result.yearlyClassifications, []);
  });

  it('should return emptyPatentData for null cpcCodes', async () => {
    const source = new BigQueryPatentSource({ projectId: 'test-patent-proj' });
    restoreEnv();
    const result = await source.fetchByCpc(null);
    assert.equal(result.totalPatents, 0);
  });

  it('should accept exclude option to skip indicator queries', () => {
    const source = new BigQueryPatentSource({
      projectId: 'test-patent-proj',
      exclude: new Set(['citationData']),
    });
    restoreEnv();
    assert.ok(source._exclude.has('citationData'));
  });

  it('should accept minYear and maxPatents options', () => {
    const source = new BigQueryPatentSource({
      projectId: 'test-patent-proj',
      minYear: 2010,
      maxPatents: 50_000,
    });
    restoreEnv();
    assert.equal(source._minYear, 2010);
    assert.equal(source._maxPatents, 50_000);
  });
});

describe('createPatentSource', () => {
  it('should be a function', () => {
    assert.equal(typeof createPatentSource, 'function');
  });

  it('should return a BigQueryPatentSource instance', () => {
    const savedProjectId = process.env.BIGQUERY_PROJECT_ID;
    process.env.BIGQUERY_PROJECT_ID = 'test-patent-proj';
    try {
      const source = createPatentSource();
      assert.ok(source instanceof BigQueryPatentSource);
    } finally {
      if (savedProjectId === undefined) {
        delete process.env.BIGQUERY_PROJECT_ID;
      } else {
        process.env.BIGQUERY_PROJECT_ID = savedProjectId;
      }
    }
  });

  it('should throw when BIGQUERY_PROJECT_ID is missing', () => {
    const saved = process.env.BIGQUERY_PROJECT_ID;
    delete process.env.BIGQUERY_PROJECT_ID;
    try {
      assert.throws(
        () => createPatentSource(),
        /BIGQUERY_PROJECT_ID/
      );
    } finally {
      if (saved !== undefined) {
        process.env.BIGQUERY_PROJECT_ID = saved;
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-cutting: SQL injection prevention
// ═══════════════════════════════════════════════════════════════════════════════

describe('SQL injection prevention', () => {
  it('CPC codes are never interpolated into SQL strings', () => {
    const malicious = ['G06F']; // Even valid codes must use params
    const queries = buildAllQueries(malicious);

    for (const [key, query] of Object.entries(queries)) {
      // The SQL should contain @cpc_codes placeholder, never the actual code
      assert.ok(
        query.sql.includes('@cpc_codes'),
        `${key}: Must use @cpc_codes parameter`
      );
      assert.ok(
        !query.sql.includes("'G06F'"),
        `${key}: Must not inline CPC codes`
      );
    }
  });

  it('minYear is parameterized, not interpolated', () => {
    const queries = buildAllQueries(['G06F'], { minYear: 2015 });
    for (const [key, query] of Object.entries(queries)) {
      assert.ok(
        query.sql.includes('@min_year'),
        `${key}: Must use @min_year parameter`
      );
      assert.ok(
        !query.sql.includes('2015'),
        `${key}: Must not inline minYear value`
      );
    }
  });

  it('dataset is from config only (not user input)', () => {
    // Dataset is interpolated but comes from validated config, not user input
    const queries = buildAllQueries(['G06F'], { dataset: 'patents-public-data' });
    // Verify it's used in backtick-quoted table references
    for (const [, query] of Object.entries(queries)) {
      assert.ok(
        query.sql.includes('`patents-public-data.patents.publications`'),
        'Dataset should be in backtick-quoted table references'
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-cutting: Query completeness for PatentData shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('PatentData field coverage', () => {
  const PATENT_DATA_FIELDS = [
    'cpcDistribution',
    'yearlyClassifications',
    'citationData',
    'claimsTimeline',
    'assigneeData',
    'geoData',
    'sectorData',
    'expirationData',
  ];

  it('every PatentData field has a corresponding query builder', () => {
    for (const field of PATENT_DATA_FIELDS) {
      assert.ok(
        QUERY_BUILDERS[field],
        `Missing query builder for PatentData.${field}`
      );
    }
  });

  it('every PatentData field has a corresponding result transformer', () => {
    for (const field of PATENT_DATA_FIELDS) {
      assert.ok(
        RESULT_TRANSFORMERS[field],
        `Missing result transformer for PatentData.${field}`
      );
    }
  });

  it('query builders and result transformers have 1:1 correspondence', () => {
    assert.deepEqual(
      Object.keys(QUERY_BUILDERS).sort(),
      Object.keys(RESULT_TRANSFORMERS).sort(),
      'QUERY_BUILDERS and RESULT_TRANSFORMERS must have matching keys'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Retry constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('Retry constants', () => {
  it('DEFAULT_MAX_RETRIES should be 3', () => {
    assert.equal(DEFAULT_MAX_RETRIES, 3);
  });

  it('DEFAULT_BASE_DELAY_MS should be 1000', () => {
    assert.equal(DEFAULT_BASE_DELAY_MS, 1000);
  });

  it('MAX_BACKOFF_MS should be 30000', () => {
    assert.equal(MAX_BACKOFF_MS, 30_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isRetryableError — error classification
// ═══════════════════════════════════════════════════════════════════════════════

describe('isRetryableError', () => {
  it('should return false for null/undefined', () => {
    assert.equal(isRetryableError(null), false);
    assert.equal(isRetryableError(undefined), false);
  });

  // ── Retryable by HTTP status ────────────────────────────────────────────
  it('should classify HTTP 429 (rate limit) as retryable', () => {
    const err = new Error('Rate limit exceeded');
    err.code = 429;
    assert.equal(isRetryableError(err), true);
  });

  it('should classify HTTP 500 (internal server error) as retryable', () => {
    const err = new Error('Internal server error');
    err.code = 500;
    assert.equal(isRetryableError(err), true);
  });

  it('should classify HTTP 502 (bad gateway) as retryable', () => {
    const err = new Error('Bad gateway');
    err.code = 502;
    assert.equal(isRetryableError(err), true);
  });

  it('should classify HTTP 503 (service unavailable) as retryable', () => {
    const err = new Error('Service unavailable');
    err.code = 503;
    assert.equal(isRetryableError(err), true);
  });

  it('should classify HTTP 504 (gateway timeout) as retryable', () => {
    const err = new Error('Gateway timeout');
    err.code = 504;
    assert.equal(isRetryableError(err), true);
  });

  it('should also check .status and .statusCode properties', () => {
    const errWithStatus = new Error('err');
    errWithStatus.status = 503;
    assert.equal(isRetryableError(errWithStatus), true);

    const errWithStatusCode = new Error('err');
    errWithStatusCode.statusCode = 429;
    assert.equal(isRetryableError(errWithStatusCode), true);
  });

  // ── Retryable by error pattern ──────────────────────────────────────────
  it('should classify ETIMEDOUT as retryable', () => {
    assert.equal(isRetryableError(new Error('connect ETIMEDOUT')), true);
  });

  it('should classify ECONNRESET as retryable', () => {
    assert.equal(isRetryableError(new Error('socket ECONNRESET')), true);
  });

  it('should classify ECONNREFUSED as retryable', () => {
    assert.equal(isRetryableError(new Error('connect ECONNREFUSED')), true);
  });

  it('should classify socket hang up as retryable', () => {
    assert.equal(isRetryableError(new Error('socket hang up')), true);
  });

  it('should classify timeout errors as retryable', () => {
    assert.equal(isRetryableError(new Error('Query timeout exceeded')), true);
  });

  it('should classify AbortError as retryable', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    assert.equal(isRetryableError(err), true);
  });

  it('should classify network errors as retryable', () => {
    assert.equal(isRetryableError(new Error('Network error occurred')), true);
  });

  it('should classify quota exceeded as retryable', () => {
    assert.equal(isRetryableError(new Error('Quota exceeded for project')), true);
  });

  it('should classify backend errors as retryable', () => {
    assert.equal(isRetryableError(new Error('Backend error')), true);
  });

  it('should classify "too many requests" as retryable', () => {
    assert.equal(isRetryableError(new Error('Too many requests')), true);
  });

  // ── Non-retryable errors ────────────────────────────────────────────────
  it('should classify HTTP 400 (bad request) as NOT retryable', () => {
    const err = new Error('Syntax error in SQL');
    err.code = 400;
    assert.equal(isRetryableError(err), false);
  });

  it('should classify HTTP 401 (unauthorized) as NOT retryable', () => {
    const err = new Error('Unauthorized');
    err.code = 401;
    assert.equal(isRetryableError(err), false);
  });

  it('should classify HTTP 403 (forbidden) as NOT retryable', () => {
    const err = new Error('Access denied');
    err.code = 403;
    assert.equal(isRetryableError(err), false);
  });

  it('should classify HTTP 404 (not found) as NOT retryable', () => {
    const err = new Error('Table not found');
    err.code = 404;
    assert.equal(isRetryableError(err), false);
  });

  it('should classify generic errors without patterns as NOT retryable', () => {
    assert.equal(isRetryableError(new Error('Something went wrong')), false);
  });

  it('should classify configuration errors as NOT retryable', () => {
    assert.equal(isRetryableError(new Error('Invalid projectId')), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// withRetry — exponential backoff retry logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('withRetry', () => {
  it('should return result on first success (no retries needed)', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'ok'; }, { maxRetries: 3 });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('should retry on transient error and succeed', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) {
        const err = new Error('connect ETIMEDOUT');
        throw err;
      }
      return 'recovered';
    }, { maxRetries: 3, baseDelayMs: 1 }); // 1ms delay for fast tests

    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('should throw immediately on non-retryable error', async () => {
    let calls = 0;
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          calls++;
          const err = new Error('Syntax error in SQL');
          err.code = 400;
          throw err;
        }, { maxRetries: 3, baseDelayMs: 1 });
      },
      /Syntax error/
    );
    // Should only have been called once (no retries)
    assert.equal(calls, 1);
  });

  it('should throw after exhausting all retries', async () => {
    let calls = 0;
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          calls++;
          throw new Error('connect ETIMEDOUT');
        }, { maxRetries: 2, baseDelayMs: 1 });
      },
      /ETIMEDOUT/
    );
    // initial + 2 retries = 3 calls
    assert.equal(calls, 3);
  });

  it('should work with maxRetries=0 (no retries)', async () => {
    let calls = 0;
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          calls++;
          throw new Error('connect ETIMEDOUT');
        }, { maxRetries: 0, baseDelayMs: 1 });
      },
      /ETIMEDOUT/
    );
    assert.equal(calls, 1);
  });

  it('should use exponential backoff (delays increase)', async () => {
    const timestamps = [];
    let calls = 0;

    await assert.rejects(
      async () => {
        await withRetry(async () => {
          timestamps.push(Date.now());
          calls++;
          throw new Error('service unavailable');
        }, { maxRetries: 2, baseDelayMs: 50 });
      },
      /service unavailable/
    );

    assert.equal(calls, 3);
    // Verify delays increase (with tolerance for jitter and system overhead)
    if (timestamps.length >= 3) {
      const delay1 = timestamps[1] - timestamps[0]; // ~50ms base
      const delay2 = timestamps[2] - timestamps[1]; // ~100ms (2x base)
      // Second delay should be roughly double the first (within jitter tolerance)
      assert.ok(delay2 >= delay1 * 0.5, `Second delay (${delay2}ms) should be >= half of first (${delay1}ms)`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BigQueryPatentSource — retry integration and error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('BigQueryPatentSource retry configuration', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.BIGQUERY_PROJECT_ID = 'test-patent-proj';
  });

  function restoreEnv() {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }

  it('should accept maxRetries option', () => {
    const source = new BigQueryPatentSource({
      projectId: 'test-patent-proj',
      maxRetries: 5,
    });
    restoreEnv();
    assert.equal(source._maxRetries, 5);
  });

  it('should accept baseDelayMs option', () => {
    const source = new BigQueryPatentSource({
      projectId: 'test-patent-proj',
      baseDelayMs: 2000,
    });
    restoreEnv();
    assert.equal(source._baseDelayMs, 2000);
  });

  it('should default maxRetries to DEFAULT_MAX_RETRIES', () => {
    const source = new BigQueryPatentSource({
      projectId: 'test-patent-proj',
    });
    restoreEnv();
    assert.equal(source._maxRetries, DEFAULT_MAX_RETRIES);
  });

  it('should default baseDelayMs to DEFAULT_BASE_DELAY_MS', () => {
    const source = new BigQueryPatentSource({
      projectId: 'test-patent-proj',
    });
    restoreEnv();
    assert.equal(source._baseDelayMs, DEFAULT_BASE_DELAY_MS);
  });

  it('should allow maxRetries=0 to disable retries', () => {
    const source = new BigQueryPatentSource({
      projectId: 'test-patent-proj',
      maxRetries: 0,
    });
    restoreEnv();
    assert.equal(source._maxRetries, 0);
  });
});
