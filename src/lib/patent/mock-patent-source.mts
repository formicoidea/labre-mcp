// MockPatentSource: test adapter implementing PatentDataSource interface.
//
// Provides configurable fixture data for testing — swappable anywhere
// BigQueryPatentSource (or any PatentDataSource) is expected.
//
// Includes pre-built fixture factories for common scenarios:
//   - commodity:  mature technology (high certitude, high ubiquity)
//   - genesis:    nascent technology (low certitude, low ubiquity)
//   - product:    mid-range technology (moderate signals)
//   - empty:      zero patents (tests confidence degradation)
//   - sparse:     few patents (tests data quality thresholds)
//
// Usage:
//   import { MockPatentSource, FIXTURES } from './mock-patent-source.mjs';
//   const source = new MockPatentSource(FIXTURES.commodity);
//   const strategy = new CpcEvolutionStrategy({ patentSource: source });
//
// The adapter tracks calls for assertion in tests:
//   source.callCount   — number of fetchByCpc calls
//   source.lastArgs    — last CPC codes passed to fetchByCpc
//   source.calls       — full history of all calls
//   source.closed      — whether close() was called

import { PatentDataSource, emptyPatentData, validatePatentData } from './patent-data-source.mjs';

// ─── Pre-built fixture data ─────────────────────────────────────────────────

/**
 * Mature technology: high certitude, high ubiquity signals.
 * Concentrated CPC distribution, stable taxonomy, high citations,
 * narrowing claims, many assignees, broad geo, cross-sector, mostly expired.
 * Expected evolution: Commodity (>= 0.70)
 *
 * @returns {import('./patent-data-source.mjs').PatentData}
 */
function commodityFixture() {
  return {
    totalPatents: 500,
    cpcDistribution: [
      { cpc: 'H04L', count: 350 },
      { cpc: 'G06F', count: 100 },
      { cpc: 'H04W', count: 50 },
    ],
    yearlyClassifications: [
      { year: 2017, cpcCodes: ['H04L', 'G06F'] },
      { year: 2018, cpcCodes: ['H04L', 'G06F', 'H04W'] },
      { year: 2019, cpcCodes: ['H04L', 'G06F', 'H04W'] },
      { year: 2020, cpcCodes: ['H04L', 'G06F', 'H04W'] },
      { year: 2021, cpcCodes: ['H04L', 'G06F', 'H04W'] },
    ],
    citationData: { totalForwardCitations: 8000, patentCount: 500 },
    claimsTimeline: [
      { year: 2015, avgIndependentClaims: 12 },
      { year: 2017, avgIndependentClaims: 8 },
      { year: 2019, avgIndependentClaims: 5 },
      { year: 2021, avgIndependentClaims: 3 },
    ],
    assigneeData: { uniqueAssignees: 200, totalPatents: 500 },
    geoData: { jurisdictionCount: 8, jurisdictions: ['US', 'EP', 'CN', 'JP', 'KR', 'IN', 'BR', 'AU'] },
    sectorData: { uniqueSections: 5, uniqueClasses: 20 },
    expirationData: { expiredCount: 350, totalPatents: 500 },
  };
}

/**
 * Nascent technology: low certitude, low ubiquity signals.
 * Even CPC distribution, unstable taxonomy, few citations,
 * expanding claims, few assignees, single jurisdiction, one sector, none expired.
 * Expected evolution: Genesis/Custom (<= 0.26)
 *
 * @returns {import('./patent-data-source.mjs').PatentData}
 */
function genesisFixture() {
  return {
    totalPatents: 8,
    cpcDistribution: [
      { cpc: 'G06N', count: 3 },
      { cpc: 'H10N', count: 3 },
      { cpc: 'B82Y', count: 2 },
    ],
    yearlyClassifications: [
      { year: 2022, cpcCodes: ['G06N'] },
      { year: 2023, cpcCodes: ['G06N', 'H10N', 'B82Y'] },
    ],
    citationData: { totalForwardCitations: 2, patentCount: 8 },
    claimsTimeline: [
      { year: 2022, avgIndependentClaims: 15 },
      { year: 2023, avgIndependentClaims: 18 },
    ],
    assigneeData: { uniqueAssignees: 4, totalPatents: 8 },
    geoData: { jurisdictionCount: 1, jurisdictions: ['US'] },
    sectorData: { uniqueSections: 1, uniqueClasses: 2 },
    expirationData: { expiredCount: 0, totalPatents: 8 },
  };
}

/**
 * Mid-range technology: moderate certitude and ubiquity signals.
 * Mixed CPC distribution, some stability, moderate citations,
 * moderate assignees, mid geo coverage, some cross-sector, some expired.
 * Expected evolution: Product (0.26 - 0.70)
 *
 * @returns {import('./patent-data-source.mjs').PatentData}
 */
function productFixture() {
  return {
    totalPatents: 150,
    cpcDistribution: [
      { cpc: 'G06F', count: 60 },
      { cpc: 'H04L', count: 50 },
      { cpc: 'G06Q', count: 40 },
    ],
    yearlyClassifications: [
      { year: 2018, cpcCodes: ['G06F', 'H04L'] },
      { year: 2019, cpcCodes: ['G06F', 'H04L', 'G06Q'] },
      { year: 2020, cpcCodes: ['G06F', 'H04L', 'G06Q'] },
      { year: 2021, cpcCodes: ['G06F', 'H04L', 'G06Q'] },
    ],
    citationData: { totalForwardCitations: 1200, patentCount: 150 },
    claimsTimeline: [
      { year: 2017, avgIndependentClaims: 10 },
      { year: 2019, avgIndependentClaims: 7 },
      { year: 2021, avgIndependentClaims: 5 },
    ],
    assigneeData: { uniqueAssignees: 45, totalPatents: 150 },
    geoData: { jurisdictionCount: 4, jurisdictions: ['US', 'EP', 'CN', 'JP'] },
    sectorData: { uniqueSections: 2, uniqueClasses: 8 },
    expirationData: { expiredCount: 30, totalPatents: 150 },
  };
}

/**
 * Sparse data: very few patents for testing confidence degradation.
 * Expected: low data quality score, low confidence.
 *
 * @returns {import('./patent-data-source.mjs').PatentData}
 */
function sparseFixture() {
  return {
    totalPatents: 3,
    cpcDistribution: [
      { cpc: 'G06N', count: 2 },
      { cpc: 'B25J', count: 1 },
    ],
    yearlyClassifications: [
      { year: 2023, cpcCodes: ['G06N', 'B25J'] },
    ],
    citationData: { totalForwardCitations: 1, patentCount: 3 },
    claimsTimeline: [
      { year: 2023, avgIndependentClaims: 12 },
    ],
    assigneeData: { uniqueAssignees: 2, totalPatents: 3 },
    geoData: { jurisdictionCount: 1, jurisdictions: ['US'] },
    sectorData: { uniqueSections: 1, uniqueClasses: 2 },
    expirationData: { expiredCount: 0, totalPatents: 3 },
  };
}

/**
 * Named fixture map for convenient access.
 * Each value is a factory function returning a fresh copy (no shared state).
 */
export const FIXTURES = Object.freeze({
  commodity: commodityFixture,
  genesis:   genesisFixture,
  product:   productFixture,
  empty:     emptyPatentData,
  sparse:    sparseFixture,
});

// ─── MockPatentSource class ─────────────────────────────────────────────────

/**
 * Test adapter implementing PatentDataSource interface.
 *
 * Extends PatentDataSource so it passes `instanceof` checks and inherits
 * the default fetchIndicators() composition (fetchByCpc → computeAllIndicators).
 *
 * Configuration:
 *   - data:       PatentData fixture to return (default: emptyPatentData)
 *   - error:      Error to throw from fetchByCpc (simulates failures)
 *   - delay:      Milliseconds to delay fetchByCpc (simulates latency)
 *   - perCpc:     Map of CPC code → PatentData for per-code responses
 *   - onFetch:    Optional callback(cpcCodes) invoked on each fetchByCpc call
 *
 * Instrumentation:
 *   - callCount:  Number of fetchByCpc calls
 *   - lastArgs:   Last CPC codes passed to fetchByCpc
 *   - calls:      Array of all { cpcCodes, timestamp } call records
 *   - closed:     Whether close() was called
 *
 * @extends PatentDataSource
 */
export class MockPatentSource extends PatentDataSource {
  // Class field declarations (TypeScript requires these to exist on the type).
  // Runtime values are set in the constructor — types are intentionally loose
  // at this migration step.
  _data: any;
  _error: any;
  _delay: any;
  _perCpc: any;
  _onFetch: any;
  callCount: any;
  lastArgs: any;
  calls: any;
  closed: any;

  /**
   * @param {Object} [options]
   * @param {import('./patent-data-source.mjs').PatentData|function():import('./patent-data-source.mjs').PatentData} [options.data]
   *   Fixed patent data to return, or a factory function that produces it.
   *   Default: emptyPatentData().
   * @param {Error} [options.error]
   *   If set, fetchByCpc will throw this error instead of returning data.
   * @param {number} [options.delay]
   *   Milliseconds to delay before returning (simulates network latency).
   * @param {Map<string, import('./patent-data-source.mjs').PatentData>|Object} [options.perCpc]
   *   Per-CPC-code responses. If a queried CPC code is found here, its data
   *   is returned instead of the default. Keys are CPC codes (e.g. 'H04L').
   * @param {function(string[]): void} [options.onFetch]
   *   Optional callback invoked with the CPC codes on each fetchByCpc call.
   */
  constructor(options: any = {}) {
    super();

    // Configuration
    this._data = options.data ?? null;
    this._error = options.error ?? null;
    this._delay = options.delay ?? 0;
    this._perCpc = options.perCpc instanceof Map
      ? options.perCpc
      : options.perCpc ? new Map(Object.entries(options.perCpc)) : null;
    this._onFetch = options.onFetch ?? null;

    // Instrumentation
    this.callCount = 0;
    this.lastArgs = null;
    this.calls = [];
    this.closed = false;
  }

  /**
   * Fetch patent data by CPC codes.
   *
   * Returns the configured fixture data (or throws the configured error).
   * Records each call in the instrumentation properties.
   *
   * Implements PatentDataSource.fetchByCpc() contract:
   *   - Accepts string[] of CPC codes
   *   - Returns Promise<PatentData>
   *   - May throw on error
   *
   * @param {string[]} cpcCodes - Array of 4-char CPC sub-class codes
   * @returns {Promise<import('./patent-data-source.mjs').PatentData>}
   */
  async fetchByCpc(cpcCodes) {
    // Record the call
    this.callCount++;
    this.lastArgs = cpcCodes;
    this.calls.push({ cpcCodes: [...(cpcCodes || [])], timestamp: Date.now() });

    // Optional callback
    if (this._onFetch) {
      this._onFetch(cpcCodes);
    }

    // Simulate latency
    if (this._delay > 0) {
      await new Promise(resolve => setTimeout(resolve, this._delay));
    }

    // Simulate error
    if (this._error) {
      throw this._error;
    }

    // Per-CPC response: return data for the first matching CPC code
    if (this._perCpc && cpcCodes) {
      for (const code of cpcCodes) {
        if (this._perCpc.has(code)) {
          const entry = this._perCpc.get(code);
          return typeof entry === 'function' ? entry() : entry;
        }
      }
    }

    // Default data
    if (this._data) {
      return typeof this._data === 'function' ? this._data() : this._data;
    }

    // Ultimate fallback: empty patent data
    return emptyPatentData();
  }

  /**
   * Lifecycle cleanup.
   * Sets the `closed` flag for test assertions.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.closed = true;
  }

  /**
   * Reset all instrumentation counters.
   * Useful when reusing a mock across multiple test cases.
   */
  reset() {
    this.callCount = 0;
    this.lastArgs = null;
    this.calls = [];
    this.closed = false;
  }
}

// ─── Convenience factory functions ──────────────────────────────────────────

/**
 * Create a MockPatentSource pre-loaded with a named fixture.
 *
 * @param {'commodity'|'genesis'|'product'|'empty'|'sparse'} fixtureName
 * @param {Object} [options] - Additional MockPatentSource options (merged with fixture)
 * @returns {MockPatentSource}
 */
export function createMockSource(fixtureName, options = {}) {
  const factory = FIXTURES[fixtureName];
  if (!factory) {
    throw new Error(
      `Unknown fixture "${fixtureName}". Available: ${Object.keys(FIXTURES).join(', ')}`
    );
  }
  return new MockPatentSource({ data: factory, ...options });
}

/**
 * Create a MockPatentSource that simulates a specific error.
 *
 * @param {string} [message='Mock BigQuery error'] - Error message
 * @param {Object} [options] - Additional MockPatentSource options
 * @returns {MockPatentSource}
 */
export function createErrorSource(message = 'Mock BigQuery error', options = {}) {
  return new MockPatentSource({ error: new Error(message), ...options });
}
