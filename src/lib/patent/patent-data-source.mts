// PatentDataSource: abstract interface for patent data access.
//
// Defines the contract that all patent data providers must implement.
// The CPC Evolution Strategy depends on this interface, not on any
// concrete implementation (BigQuery, mock, CSV, etc.).
//
// Implementations:
//   - BigQueryPatentSource (bigquery-patent-source.mjs) — production
//   - Mock objects in tests ({ fetchByCpc: async () => data })
//
// The interface specifies two contract methods:
//   1. fetchByCpc(cpcCodes)      — fetch raw patent data by CPC sub-class codes
//   2. fetchIndicators(cpcCodes) — convenience: fetch + compute all 8 indicators
//
// Method (2) has a default implementation that composes fetchByCpc() with
// computeAllIndicators() from patent-indicators.mjs, so concrete classes
// only MUST implement fetchByCpc().
//
// Return shapes are documented via JSDoc typedefs below to serve as the
// single source of truth for all consumers (strategy, cache, tests).

// ─── Return shape typedefs ─────────────────────────────────────────────────────

/**
 * CPC subclass distribution entry.
 * @typedef {Object} CpcDistributionEntry
 * @property {string} cpc   - 4-char CPC sub-class code (e.g. 'H04L')
 * @property {number} count - Number of patents assigned to this subclass
 */

/**
 * Yearly CPC classification snapshot.
 * @typedef {Object} YearlyClassification
 * @property {number}   year     - Calendar year
 * @property {string[]} cpcCodes - CPC sub-class codes used in patents that year
 */

/**
 * Forward citation data for a CPC class.
 * @typedef {Object} CitationData
 * @property {number} totalForwardCitations - Total forward citations received
 * @property {number} patentCount           - Number of patents in the class
 */

/**
 * Claims timeline entry for narrowing analysis.
 * @typedef {Object} ClaimsTimelineEntry
 * @property {number} year                  - Calendar year
 * @property {number} avgIndependentClaims  - Average independent claims per patent
 */

/**
 * Assignee diversity data.
 * @typedef {Object} AssigneeData
 * @property {number} uniqueAssignees - Count of unique patent assignees (holders)
 * @property {number} totalPatents    - Total patents in the class
 */

/**
 * Geographic filing coverage data.
 * @typedef {Object} GeoData
 * @property {number}   jurisdictionCount - Number of unique patent jurisdictions
 * @property {string[]} [jurisdictions]   - Optional list of jurisdiction codes (e.g. ['US', 'EP', 'CN'])
 */

/**
 * Cross-sector diffusion data.
 * @typedef {Object} SectorData
 * @property {number} uniqueSections - Number of unique CPC sections (A-H, Y; max 9)
 * @property {number} uniqueClasses  - Number of unique CPC main classes
 */

/**
 * Patent expiration data for commoditization analysis.
 * @typedef {Object} ExpirationData
 * @property {number} expiredCount - Number of expired patents
 * @property {number} totalPatents - Total patents (expired + active)
 */

/**
 * Complete patent data for a set of CPC codes.
 *
 * This is the canonical return shape of fetchByCpc() and the input shape
 * consumed by computeAllIndicators() from patent-indicators.mjs.
 *
 * All fields feed one or more of the 8 patent indicators:
 *
 * Certitude axis:
 *   cpcDistribution          -> convergenceHHI (indicator 1)
 *   yearlyClassifications    -> stabiliteTaxonomique (indicator 2)
 *   citationData             -> densiteCitation (indicator 3)
 *   claimsTimeline           -> retrecissementClaims (indicator 4)
 *
 * Ubiquity axis:
 *   assigneeData             -> diversiteAssignees (indicator 5)
 *   geoData                  -> couvertureGeo (indicator 6)
 *   sectorData               -> diffusionSectorielle (indicator 7)
 *   expirationData           -> ratioExpires (indicator 8)
 *
 * @typedef {Object} PatentData
 * @property {number}                   totalPatents            - Total patent count (used for confidence scoring)
 * @property {CpcDistributionEntry[]}   cpcDistribution         - CPC subclass distribution
 * @property {YearlyClassification[]}   yearlyClassifications   - Yearly CPC code snapshots
 * @property {CitationData}             citationData            - Forward citation aggregates
 * @property {ClaimsTimelineEntry[]}    claimsTimeline          - Independent claims over time
 * @property {AssigneeData}             assigneeData            - Assignee diversity
 * @property {GeoData}                  geoData                 - Geographic filing breadth
 * @property {SectorData}               sectorData              - Cross-sector diffusion
 * @property {ExpirationData}           expirationData          - Patent expiration ratios
 */

/**
 * Computed indicator results for both axes.
 * Returned by fetchIndicators() convenience method.
 *
 * @typedef {Object} IndicatorResults
 * @property {{ value: number, breakdown: Array, enabledCount: number }} certitude  - Aggregated certitude axis
 * @property {{ value: number, breakdown: Array, enabledCount: number }} ubiquite   - Aggregated ubiquity axis
 * @property {Record<string, number>}                                    scores     - All 8 individual indicator scores
 */

// ─── Empty/default patent data ─────────────────────────────────────────────────

/**
 * Canonical empty PatentData shape.
 * Used as fallback when no data is available (e.g. CPC codes not found,
 * BigQuery returns zero results, or data source is unavailable).
 *
 * All indicator functions handle empty/zero inputs gracefully, returning 0.
 *
 * @returns {PatentData}
 */
export function emptyPatentData() {
  return {
    totalPatents: 0,
    cpcDistribution: [],
    yearlyClassifications: [],
    citationData: { totalForwardCitations: 0, patentCount: 0 },
    claimsTimeline: [],
    assigneeData: { uniqueAssignees: 0, totalPatents: 0 },
    geoData: { jurisdictionCount: 0, jurisdictions: [] },
    sectorData: { uniqueSections: 0, uniqueClasses: 0 },
    expirationData: { expiredCount: 0, totalPatents: 0 },
  };
}

// ─── Abstract base class ───────────────────────────────────────────────────────

/**
 * Abstract interface for patent data access.
 *
 * All patent data providers must extend this class and implement fetchByCpc().
 * The fetchIndicators() convenience method has a default implementation that
 * composes fetchByCpc() with computeAllIndicators().
 *
 * Concrete implementations:
 *   - BigQueryPatentSource — queries Google BigQuery Patents Public Dataset
 *   - Mock sources in tests — return static fixture data
 *
 * Usage in CpcEvolutionStrategy:
 *   const source = new BigQueryPatentSource({ projectId: '...' });
 *   const patentData = await source.fetchByCpc(['H04L', 'G06F']);
 *   // patentData is a PatentData object ready for computeAllIndicators()
 *
 * @abstract
 */
export class PatentDataSource {

  /**
   * Fetch raw patent data for the given CPC sub-class codes.
   *
   * This is the core contract method that all implementations MUST override.
   * Returns a PatentData object containing all fields needed by the 8 patent
   * indicators in patent-indicators.mjs.
   *
   * Implementations should:
   *   - Accept 1–5 CPC sub-class codes (4-char format, e.g. 'H04L')
   *   - Return a complete PatentData object (use emptyPatentData() for missing fields)
   *   - Handle network/query errors gracefully (throw or return empty)
   *   - Be safe to call concurrently (stateless queries)
   *
   * @abstract
   * @param {string[]} cpcCodes - Array of 4-char CPC sub-class codes (e.g. ['H04L', 'G06F'])
   * @returns {Promise<PatentData>} Patent data for the given CPC codes
   * @throws {Error} If not implemented by subclass
   */
  async fetchByCpc(cpcCodes: string[]): Promise<any> {
    throw new Error(
      `${this.constructor.name}.fetchByCpc() must be implemented by subclass`
    );
  }

  /**
   * Convenience method: fetch patent data and compute all 8 indicators.
   *
   * Default implementation composes fetchByCpc() with computeAllIndicators()
   * from patent-indicators.mjs. Subclasses may override this to provide
   * pre-computed indicators (e.g. from a cache or a specialized API).
   *
   * @param {string[]} cpcCodes - Array of 4-char CPC sub-class codes
   * @param {Object} [options]
   * @param {Array<{key: string, weight: number, enabled: boolean}>} [options.certitudeConfig]
   *   Custom certitude indicator config (for toggling/reweighting)
   * @param {Array<{key: string, weight: number, enabled: boolean}>} [options.ubiquiteConfig]
   *   Custom ubiquity indicator config (for toggling/reweighting)
   * @returns {Promise<IndicatorResults>} Computed indicator results for both axes
   */
  async fetchIndicators(cpcCodes, options = {}) {
    const patentData = await this.fetchByCpc(cpcCodes);

    // Lazy-load to avoid circular dependencies and keep base class lightweight
    const { computeAllIndicators } = await import('./patent-indicators.mjs');

    return computeAllIndicators(patentData, options);
  }

  /**
   * Optional lifecycle method: release resources (connections, caches).
   * Implementations that hold resources (connection pools, timers) should
   * override this to clean up gracefully.
   *
   * @returns {Promise<void>}
   */
  async close() {
    // Default: no-op. Subclasses override if needed.
  }
}

// ─── Validation helpers ────────────────────────────────────────────────────────

/**
 * Validate that an object conforms to the PatentData shape.
 * Checks for required fields and correct types. Used by tests and cache
 * to ensure data integrity after deserialization.
 *
 * @param {*} data - Object to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePatentData(data) {
  const errors = [];

  if (data === null || typeof data !== 'object') {
    return { valid: false, errors: ['PatentData must be a non-null object'] };
  }

  // totalPatents
  if (typeof data.totalPatents !== 'number' || data.totalPatents < 0) {
    errors.push('totalPatents must be a non-negative number');
  }

  // cpcDistribution
  if (!Array.isArray(data.cpcDistribution)) {
    errors.push('cpcDistribution must be an array');
  }

  // yearlyClassifications
  if (!Array.isArray(data.yearlyClassifications)) {
    errors.push('yearlyClassifications must be an array');
  }

  // citationData
  if (!data.citationData || typeof data.citationData !== 'object') {
    errors.push('citationData must be a non-null object');
  }

  // claimsTimeline
  if (!Array.isArray(data.claimsTimeline)) {
    errors.push('claimsTimeline must be an array');
  }

  // assigneeData
  if (!data.assigneeData || typeof data.assigneeData !== 'object') {
    errors.push('assigneeData must be a non-null object');
  }

  // geoData
  if (!data.geoData || typeof data.geoData !== 'object') {
    errors.push('geoData must be a non-null object');
  }

  // sectorData
  if (!data.sectorData || typeof data.sectorData !== 'object') {
    errors.push('sectorData must be a non-null object');
  }

  // expirationData
  if (!data.expirationData || typeof data.expirationData !== 'object') {
    errors.push('expirationData must be a non-null object');
  }

  return { valid: errors.length === 0, errors };
}
