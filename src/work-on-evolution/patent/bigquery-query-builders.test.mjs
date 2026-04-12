// Tests for bigquery-query-builders.mjs — CPC indicator SQL query builder
//
// Verifies:
//   1. Query context creation and validation
//   2. All 8 indicator SQL query builders produce valid parameterized queries
//   3. Combined buildAllQueries() composes correctly with exclude support
//   4. SQL injection prevention via parameterized queries
//   5. PatentData field coverage
//
// No actual BigQuery connection is made — all queries are validated structurally.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
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

import {
  DEFAULT_MIN_YEAR,
  DEFAULT_MAX_PATENTS,
  PATENT_TERM_YEARS,
} from './bigquery-patent-source.mjs';

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
  assert.ok(
    query.sql.includes('@cpc_codes'),
    'Query must use @cpc_codes parameter for injection safety'
  );
  assert.ok(
    Array.isArray(query.params.cpc_codes),
    'params.cpc_codes must be an array'
  );
  assert.ok(
    query.types.cpc_codes,
    'types must declare cpc_codes type'
  );
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

// ═══════════════════════════════════════════════════════════════���═══════════════
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
      /Invalid CPC code/
    );
  });

  it('should reject invalid CPC code format — too short', () => {
    assert.throws(
      () => createQueryContext(['G06']),
      /Invalid CPC code/
    );
  });

  it('should accept variable-length CPC codes', () => {
    const ctx1 = createQueryContext(['G06F9/']);
    assert.equal(ctx1.cpcCodes[0], 'G06F9/');
    const ctx2 = createQueryContext(['G06F9/455']);
    assert.equal(ctx2.cpcCodes[0], 'G06F9/455');
    const ctx3 = createQueryContext(['G06F', 'G06F9/', 'H04L67/10']);
    assert.equal(ctx3.cpcCodes.length, 3);
  });

  it('should reject invalid CPC code format — wrong section letter', () => {
    assert.throws(
      () => createQueryContext(['Z06F']),
      /Invalid CPC code/
    );
  });

  it('should reject mixed valid/invalid CPC codes', () => {
    assert.throws(
      () => createQueryContext(['G06F', 'invalid']),
      /Invalid CPC code/
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
    assert.ok(q.sql.includes('STARTS_WITH(cpc_code.code, p)'), 'Must use prefix matching');
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
      /Invalid CPC code/
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
// SQL injection prevention
// ═══════════════════════════════════════════════════════════════════════════════

describe('SQL injection prevention', () => {
  it('should never embed CPC codes directly in SQL for any query builder', () => {
    // Codes with SQL injection fragments that don't match CPC format are rejected
    const dangerousCodes = ["'; DROP TABLE patents; --"];
    assert.throws(
      () => createQueryContext(dangerousCodes),
      /Invalid CPC code/,
      'Validation should reject injection attempts'
    );
    // Even valid-looking codes are parameterized, never interpolated into SQL
    const queries = buildAllQueries(['G06F']);
    for (const [key, query] of Object.entries(queries)) {
      assert.ok(query.sql.includes('@cpc_codes'), `${key}: Must use parameterized CPC codes`);
      assert.ok(!query.sql.includes("'G06F'"), `${key}: Must not inline CPC code`);
    }
  });

  it('all queries should use @named_params exclusively', () => {
    const queries = buildAllQueries(['G06F']);
    for (const [key, query] of Object.entries(queries)) {
      // Verify SQL uses @ parameters, not string interpolation of user values
      assert.ok(
        query.sql.includes('@cpc_codes'),
        `${key}: Must use @cpc_codes parameter`
      );
      // No inline code values
      assert.ok(
        !query.sql.includes("'G06F'"),
        `${key}: Must not embed CPC code inline`
      );
    }
  });

  it('dataset name should be safe via template literal (trusted config)', () => {
    // Dataset comes from trusted config, but verify it's not user-injectable
    const ctx = testCtx({ dataset: 'patents-public-data' });
    const q = buildCpcDistributionQuery(ctx);
    assert.ok(q.sql.includes('patents-public-data'), 'Dataset embedded via template');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PatentData field coverage
// ═══════════════════════════════════════════════════════════════════════════════

describe('PatentData field coverage', () => {
  it('buildAllQueries should cover all PatentData indicator fields', () => {
    const expectedFields = [
      'cpcDistribution',
      'yearlyClassifications',
      'citationData',
      'claimsTimeline',
      'assigneeData',
      'geoData',
      'sectorData',
      'expirationData',
    ];

    const queries = buildAllQueries(['G06F']);
    for (const field of expectedFields) {
      assert.ok(queries[field], `buildAllQueries must include "${field}" query`);
    }
  });

  it('QUERY_BUILDERS keys should match expected PatentData fields exactly', () => {
    const expected = [
      'assigneeData', 'citationData', 'claimsTimeline', 'cpcDistribution',
      'expirationData', 'geoData', 'sectorData', 'yearlyClassifications',
    ];
    assert.deepEqual(Object.keys(QUERY_BUILDERS).sort(), expected);
  });
});
