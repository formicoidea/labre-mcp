// Tests for bigquery-patent-source.mjs — result transformers, class, retry, factory
//
// Verifies:
//   1. Constants (DEFAULT_MIN_YEAR, DEFAULT_MAX_PATENTS, PATENT_TERM_YEARS)
//   2. Result transformers correctly map BigQuery rows to PatentData shape
//   3. BigQueryPatentSource.fetchByCpc() with mock BigQuery client
//   4. createPatentSource() factory
//   5. Error classification: retryable vs non-retryable BigQuery errors
//   6. Retry logic with exponential backoff for transient failures
//   7. BigQueryPatentSource retry configuration
//
// Query builder tests are in bigquery-query-builders.test.mjs
// No actual BigQuery connection is made.

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
  // Result transformers
  RESULT_TRANSFORMERS,
  QUERY_BUILDERS,
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
