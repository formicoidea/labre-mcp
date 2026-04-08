// CPC Evolution Strategy: patent-based evolution estimation using CPC data
//
// Uses 8 patent indicators (via BigQuery) split across two axes:
//   Certitude (4 indicators): convergence HHI, stabilite taxonomique,
//                              densite citations, maturite claims
//   Ubiquity  (4 indicators): diversite assignees, couverture geo,
//                              diffusion sectorielle, ratio expires
//
// Each indicator is individually toggleable with automatic weight renormalization.
// Scoring is delegated entirely to computeEvolution(certitude, ubiquity) from
// s-curve.mjs — no custom S-curve logic or scoring bypass.
//
// Pipeline integration:
//   1. CPC mapper translates component.capability to CPC codes
//   2. PatentDataSource (BigQuery) fetches raw patent data
//   3. patent-indicators.mjs computes 8 pure-function indicators
//   4. Indicators are aggregated into (certitude, ubiquity) pair
//   5. computeEvolution(c, u) produces the evolution score
//   6. Result exposes certitude/ubiquity for Phase B enrichment
//
// Auto-discovery: re-exported from src/strategies/cpc-evolution-strategy.mjs
// so the registry picks it up alongside other *-strategy.mjs files.

import { BaseStrategy } from '../strategies/base-strategy.mjs';
import { computeEvolution } from '../s-curve.mjs';
import { getCpcTitle } from './cpc-taxonomy-cache.mjs';

// ─── Default indicator configuration ────────────────────────────────────────

/**
 * Default weights for certitude indicators (must sum to 1.0 when all enabled).
 * Keys match patent-indicators.mjs function names.
 * @type {Record<string, { weight: number, enabled: boolean }>}
 */
const DEFAULT_CERTITUDE_INDICATORS = {
  convergenceHHI:       { weight: 0.30, enabled: true },
  stabiliteTaxonomique: { weight: 0.20, enabled: true },
  densiteCitation:      { weight: 0.25, enabled: true },
  retrecissementClaims: { weight: 0.25, enabled: true },
};

/**
 * Default weights for ubiquity indicators (must sum to 1.0 when all enabled).
 * Keys match patent-indicators.mjs function names.
 * @type {Record<string, { weight: number, enabled: boolean }>}
 */
const DEFAULT_UBIQUITY_INDICATORS = {
  diversiteAssignees:   { weight: 0.30, enabled: true },
  couvertureGeo:        { weight: 0.25, enabled: true },
  diffusionSectorielle: { weight: 0.25, enabled: true },
  ratioExpires:         { weight: 0.20, enabled: true },
};

// ─── Weight renormalization ─────────────────────────────────────────────────

/**
 * Renormalize weights for enabled indicators so they sum to 1.0.
 * Disabled indicators are excluded from the sum.
 *
 * @param {Record<string, { weight: number, enabled: boolean }>} indicators
 * @returns {Record<string, number>} Map of indicator name → renormalized weight (enabled only)
 */
function renormalizeWeights(indicators) {
  const enabled = Object.entries(indicators)
    .filter(([, cfg]) => cfg.enabled);

  if (enabled.length === 0) {
    return {};
  }

  const totalWeight = enabled.reduce((sum, [, cfg]) => sum + cfg.weight, 0);

  const normalized = {};
  for (const [name, cfg] of enabled) {
    normalized[name] = totalWeight > 0 ? cfg.weight / totalWeight : 1 / enabled.length;
  }
  return normalized;
}

// ─── Confidence model ───────────────────────────────────────────────────────

/**
 * Data quality score based on patent count thresholds.
 * Degrades gracefully with insufficient data.
 *
 * @param {number} patentCount - Number of patents found
 * @returns {number} Data quality score in [0.2, 0.9]
 */
function computeDataQuality(patentCount) {
  if (patentCount < 10) {
    // Very few patents: low confidence, linear ramp from 0.2 to 0.4
    return 0.2 + (patentCount / 10) * 0.2;
  }
  if (patentCount <= 100) {
    // Moderate data: linear ramp from 0.4 to 0.7
    return 0.4 + ((patentCount - 10) / 90) * 0.3;
  }
  // Abundant data: logarithmic approach to 0.9
  return Math.min(0.9, 0.7 + Math.log10(patentCount / 100) * 0.1);
}

/**
 * Model confidence based on how well the (certitude, ubiquity) point
 * fits within the S-curve band.
 *
 * @param {Object} scurveResult - Result from computeEvolution()
 * @returns {number} Model confidence score in [0.3, 0.95]
 */
function computeModelConfidence(scurveResult) {
  if (scurveResult.zone === 'competitive') {
    // Inside band: high model confidence, scaled by distance to center
    return Math.min(0.95, 0.8 + (1 - Math.min(scurveResult.distToCenter, 0.3) / 0.3) * 0.15);
  }
  // Outside band: lower confidence, decays with band distance
  const absDist = Math.abs(scurveResult.bandDistance);
  return Math.max(0.3, 0.7 - absDist * 2);
}

/**
 * Combined confidence = dataQuality * 0.5 + modelConfidence * 0.5, bounded [0.1, 0.95].
 *
 * @param {number} dataQuality - Patent data quality score
 * @param {number} modelConfidence - S-curve model fit confidence
 * @returns {number} Bounded confidence score
 */
function computeConfidence(dataQuality, modelConfidence) {
  const raw = dataQuality * 0.5 + modelConfidence * 0.5;
  return Math.round(Math.max(0.1, Math.min(0.95, raw)) * 1000) / 1000;
}

// ─── Aggregate indicators into axis score ───────────────────────────────────

/**
 * Aggregate individual indicator values into a single axis score
 * using renormalized weights.
 *
 * @param {Record<string, number>} indicatorValues - Computed indicator values (0-1 each)
 * @param {Record<string, number>} weights - Renormalized weights (enabled indicators only)
 * @returns {number} Weighted aggregate score in [0, 1]
 */
function aggregateAxis(indicatorValues, weights) {
  let sum = 0;
  let totalWeight = 0;

  for (const [name, weight] of Object.entries(weights)) {
    const value = indicatorValues[name];
    if (value != null && !Number.isNaN(value)) {
      sum += value * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0) return 0.5; // Neutral fallback
  return Math.round((sum / totalWeight) * 1000) / 1000;
}

// ─── Strategy class ─────────────────────────────────────────────────────────

/**
 * CPC Evolution Strategy: uses patent CPC data to estimate component evolution.
 *
 * Extends BaseStrategy for auto-discovery by the plugin system.
 * Delegates scoring entirely to computeEvolution(certitude, ubiquity) from s-curve.mjs.
 * Exposes certitude/ubiquity on result for Phase B enrichment.
 *
 * @example
 *   const strategy = new CpcEvolutionStrategy({ llmCall, patentSource });
 *   const result = await strategy.evaluate({ name: 'Kubernetes', capability: 'container orchestration' });
 *   // result.evolution, result.confidence, result.certitude, result.ubiquity
 */
export class CpcEvolutionStrategy extends BaseStrategy {

  /**
   * @param {Object} [options]
   * @param {function(string): Promise<string>} [options.llmCall]
   *   Async LLM call for CPC mapper (falls back to hardcoded mappings if absent).
   * @param {import('./patent-data-source.mjs').PatentDataSource} [options.patentSource]
   *   Patent data source (defaults to BigQueryPatentSource from env vars).
   * @param {import('./cpc-mapper.mjs').CpcMapper} [options.cpcMapper]
   *   CPC code mapper (defaults to LLM-assisted + hardcoded fallback).
   * @param {Object} [options.config]
   *   Configuration overrides.
   * @param {Record<string, { weight?: number, enabled?: boolean }>} [options.config.certitudeIndicators]
   *   Override certitude indicator weights/toggles.
   * @param {Record<string, { weight?: number, enabled?: boolean }>} [options.config.ubiquityIndicators]
   *   Override ubiquity indicator weights/toggles.
   */
  constructor(options = {}) {
    super();
    this._llmCall = options.llmCall || null;
    this._patentSource = options.patentSource || null;
    this._cpcMapper = options.cpcMapper || null;

    // Merge indicator config with defaults
    this._certitudeIndicators = mergeIndicatorConfig(
      DEFAULT_CERTITUDE_INDICATORS,
      options.config?.certitudeIndicators
    );
    this._ubiquityIndicators = mergeIndicatorConfig(
      DEFAULT_UBIQUITY_INDICATORS,
      options.config?.ubiquityIndicators
    );
  }

  /** @returns {string} Strategy identifier for registry. */
  static get method() {
    return 'cpc-evolution';
  }

  /**
   * Evaluate a component's evolution using patent CPC data.
   *
   * Pipeline:
   *   1. Map component capability to CPC codes
   *   2. Fetch patent data via PatentDataSource
   *   3. Compute 8 indicators (pure functions)
   *   4. Aggregate into (certitude, ubiquity)
   *   5. Delegate to computeEvolution(c, u)
   *   6. Build confidence from data quality + model fit
   *
   * **GUARANTEE: Always returns a valid EvolutionResult — never throws, never
   * returns null.** When data is missing, unavailable, or any internal error
   * occurs, the strategy degrades gracefully to a low-confidence result with
   * neutral (0.5, 0.5) defaults. Phase B enrichment in estimate-evolution.mjs
   * uses the confidence score to weight this strategy's contribution alongside
   * other strategies, so low confidence naturally reduces its influence on the
   * final evolution estimate without requiring abstention.
   *
   * Degradation tiers:
   *   - No CPC codes found → neutral indicators (0.5), confidence ≈ 0.25
   *   - No patents found   → neutral indicators (0.5), confidence ≈ 0.25
   *   - <10 patents        → real indicators, confidence 0.25–0.45
   *   - 10–100 patents     → real indicators, confidence 0.45–0.65
   *   - >100 patents       → real indicators, confidence 0.55–0.95
   *   - Unexpected error    → fallback result, confidence = 0.1 (minimum)
   *
   * @param {import('../strategies/base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('../strategies/base-strategy.mjs').EvolutionResult & { certitude: number, ubiquity: number }>}
   */
  async evaluate(component) {
    try {
      return await this._evaluateInternal(component);
    } catch (err) {
      // ── SAFETY NET: guarantee no abstention ────────────────────────────
      // If anything in the pipeline throws unexpectedly (BigQuery timeout,
      // s-curve NaN, indicator bug, etc.), we still return a valid result
      // with minimum confidence so Phase B weighting naturally deprioritizes it.
      return this._buildFallbackResult(err);
    }
  }

  /**
   * Internal evaluation pipeline — separated from evaluate() so the top-level
   * safety net can catch any unexpected error without duplicating fallback logic.
   *
   * @param {import('../strategies/base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('../strategies/base-strategy.mjs').EvolutionResult & { certitude: number, ubiquity: number }>}
   * @private
   */
  async _evaluateInternal(component) {
    // Step 1: Resolve CPC codes for the component
    const cpcCodes = await this._resolveCpcCodes(component);

    // Step 2: Fetch patent data
    const patentData = await this._fetchPatentData(cpcCodes);

    // Step 3: Compute all 8 indicators via pure functions
    const indicatorValues = await this._computeIndicators(patentData, cpcCodes);

    // Step 4: Renormalize weights for enabled indicators
    const certitudeWeights = renormalizeWeights(this._certitudeIndicators);
    const ubiquityWeights = renormalizeWeights(this._ubiquityIndicators);

    // Step 5: Aggregate indicators into (certitude, ubiquity)
    const certitude = aggregateAxis(indicatorValues.certitude, certitudeWeights);
    const ubiquity = aggregateAxis(indicatorValues.ubiquity, ubiquityWeights);

    // Step 6: Delegate to S-curve model — the ONLY scoring path
    const scurveResult = computeEvolution(certitude, ubiquity);

    // Step 7: Build confidence from data quality + model fit
    const patentCount = patentData?.totalPatents ?? 0;
    const dataQuality = computeDataQuality(patentCount);
    const modelConfidence = computeModelConfidence(scurveResult);
    const confidence = computeConfidence(dataQuality, modelConfidence);

    // Build result following BaseStrategy contract + Phase B enrichment pattern
    const result = {
      evolution: scurveResult.evolution,
      confidence,
      method: CpcEvolutionStrategy.method,
      // Expose certitude/ubiquity for Phase B enrichment (same as sector-agent-strategy)
      certitude,
      ubiquity,
      // Detailed trace for debugging and transparency
      trace: [
        { step: 'cpc-codes', value: cpcCodes.map(code => ({ code, title: getCpcTitle(code) })) },
        { step: 'patent-count', value: patentCount },
        { step: 'certitude-indicators', value: indicatorValues.certitude, weights: certitudeWeights },
        { step: 'ubiquity-indicators', value: indicatorValues.ubiquity, weights: ubiquityWeights },
        { step: 'aggregated', certitude, ubiquity },
        { step: 's-curve', ...scurveResult },
        { step: 'confidence', dataQuality, modelConfidence, combined: confidence },
      ],
    };

    return BaseStrategy.validateResult(result);
  }

  /**
   * Build a minimal valid fallback result when the pipeline fails unexpectedly.
   *
   * Uses neutral (0.5, 0.5) inputs to computeEvolution so the evolution score
   * is still derived from the calibrated S-curve model (no custom scoring bypass).
   * Confidence is set to the minimum (0.1) so Phase B enrichment weighting
   * naturally deprioritizes this result.
   *
   * @param {Error} err - The error that triggered the fallback
   * @returns {import('../strategies/base-strategy.mjs').EvolutionResult & { certitude: number, ubiquity: number }}
   * @private
   */
  _buildFallbackResult(err) {
    // Neutral midpoint — still delegate to S-curve for evolution score
    const NEUTRAL = 0.5;
    let evolution = NEUTRAL;

    try {
      const scurveResult = computeEvolution(NEUTRAL, NEUTRAL);
      evolution = scurveResult.evolution;
    } catch {
      // Even S-curve failed — use raw neutral value (this should never happen
      // with valid [0,1] inputs, but guarantees we still return a result)
    }

    return BaseStrategy.validateResult({
      evolution,
      confidence: 0.1,  // Minimum confidence — Phase B will deprioritize
      method: CpcEvolutionStrategy.method,
      certitude: NEUTRAL,
      ubiquity: NEUTRAL,
      trace: [
        { step: 'fallback', reason: err?.message || 'unknown error' },
        { step: 'aggregated', certitude: NEUTRAL, ubiquity: NEUTRAL },
        { step: 'confidence', dataQuality: 0.2, modelConfidence: 0, combined: 0.1 },
      ],
    });
  }

  // ─── Runtime indicator management (AC 12) ───────────────────────────────

  /**
   * Enable or disable an individual indicator at runtime.
   * Weights are automatically renormalized on next evaluate() call.
   *
   * @param {'certitude'|'ubiquity'} axis - Which axis the indicator belongs to
   * @param {string} key - Indicator key (e.g. 'convergenceHHI', 'diversiteAssignees')
   * @param {boolean} enabled - Whether to enable or disable the indicator
   * @throws {Error} If the indicator key is not found on the given axis
   */
  setIndicatorEnabled(axis, key, enabled) {
    const indicators = axis === 'certitude'
      ? this._certitudeIndicators
      : this._ubiquityIndicators;

    if (!(key in indicators)) {
      throw new Error(
        `Unknown ${axis} indicator: "${key}". ` +
        `Valid keys: ${Object.keys(indicators).join(', ')}`
      );
    }
    indicators[key] = { ...indicators[key], enabled: Boolean(enabled) };
  }

  /**
   * Bulk-update indicator enabled/disabled flags.
   * Accepts a map of indicator key → boolean for each axis.
   * Keys not present in the map are left unchanged.
   *
   * @param {Object} toggles
   * @param {Record<string, boolean>} [toggles.certitude] - Certitude indicator toggles
   * @param {Record<string, boolean>} [toggles.ubiquity] - Ubiquity indicator toggles
   */
  setIndicatorsEnabled(toggles = {}) {
    if (toggles.certitude) {
      for (const [key, enabled] of Object.entries(toggles.certitude)) {
        if (key in this._certitudeIndicators) {
          this._certitudeIndicators[key] = { ...this._certitudeIndicators[key], enabled: Boolean(enabled) };
        }
      }
    }
    if (toggles.ubiquity) {
      for (const [key, enabled] of Object.entries(toggles.ubiquity)) {
        if (key in this._ubiquityIndicators) {
          this._ubiquityIndicators[key] = { ...this._ubiquityIndicators[key], enabled: Boolean(enabled) };
        }
      }
    }
  }

  /**
   * Get the current indicator configuration for both axes.
   * Includes raw weights, enabled status, and renormalized weights.
   *
   * @returns {{
   *   certitude: Array<{key: string, weight: number, enabled: boolean, weightNormalized: number}>,
   *   ubiquity: Array<{key: string, weight: number, enabled: boolean, weightNormalized: number}>,
   * }}
   */
  getIndicatorConfig() {
    const certitudeWeights = renormalizeWeights(this._certitudeIndicators);
    const ubiquityWeights = renormalizeWeights(this._ubiquityIndicators);

    return {
      certitude: Object.entries(this._certitudeIndicators).map(([key, cfg]) => ({
        key,
        weight: cfg.weight,
        enabled: cfg.enabled,
        weightNormalized: certitudeWeights[key] ?? 0,
      })),
      ubiquity: Object.entries(this._ubiquityIndicators).map(([key, cfg]) => ({
        key,
        weight: cfg.weight,
        enabled: cfg.enabled,
        weightNormalized: ubiquityWeights[key] ?? 0,
      })),
    };
  }

  /**
   * Get only the renormalized weights for currently enabled indicators.
   * Useful for inspecting what weights will be used in the next evaluate() call.
   *
   * @returns {{
   *   certitude: Record<string, number>,
   *   ubiquity: Record<string, number>,
   * }}
   */
  getActiveWeights() {
    return {
      certitude: renormalizeWeights(this._certitudeIndicators),
      ubiquity: renormalizeWeights(this._ubiquityIndicators),
    };
  }

  /**
   * Reset indicator configuration to defaults (all enabled, original weights).
   */
  resetIndicatorConfig() {
    this._certitudeIndicators = { ...DEFAULT_CERTITUDE_INDICATORS };
    this._ubiquityIndicators = { ...DEFAULT_UBIQUITY_INDICATORS };
  }

  // ─── Internal pipeline methods ──────────────────────────────────────────

  /**
   * Resolve CPC codes from component capability via CPC mapper.
   * Uses progressive discovery (LLM + taxonomy cache) when available.
   * Falls back to empty array if no mapper available (confidence will be low).
   *
   * @param {import('../strategies/base-strategy.mjs').ComponentInput} component
   * @returns {Promise<string[]>} Array of CPC codes (variable length)
   */
  async _resolveCpcCodes(component) {
    if (this._cpcMapper) {
      try {
        const result = await this._cpcMapper.mapToCpc(component);
        // Handle both old (string[]) and new ({codes, titles}) return formats
        return Array.isArray(result) ? result : result.codes || [];
      } catch {
        // Mapper failed — try default mapper below
      }
    }

    // Lazy-load CPC mapper + taxonomy cache
    try {
      const { mapComponentToCpc } = await import('./cpc-mapper.mjs');
      const { setCpcTitle } = await import('./cpc-taxonomy-cache.mjs');

      // Try to create taxonomy cache for progressive discovery
      let taxonomyCache = null;
      try {
        const { createTaxonomyCache } = await import('./cpc-taxonomy-cache.mjs');
        taxonomyCache = await createTaxonomyCache();
      } catch {
        // Cache unavailable — mapper will use LLM fallback
      }

      const result = await mapComponentToCpc(component, this._llmCall, { taxonomyCache });

      // Register titles from discovery into the global title store
      if (result.titles) {
        for (const [code, title] of Object.entries(result.titles)) {
          setCpcTitle(code, title);
        }
      }

      return result.codes || [];
    } catch {
      // Module not available or failed — return empty
      return [];
    }
  }

  /**
   * Fetch patent data from the configured data source.
   * Returns a minimal stub if no data source is available.
   *
   * @param {string[]} cpcCodes
   * @returns {Promise<Object>} Patent data object
   */
  async _fetchPatentData(cpcCodes) {
    if (cpcCodes.length === 0) {
      return { totalPatents: 0, patents: [] };
    }

    if (this._patentSource) {
      try {
        return await this._patentSource.fetchByCpc(cpcCodes);
      } catch {
        return { totalPatents: 0, patents: [] };
      }
    }

    // Lazy-load BigQuery patent source
    try {
      const { createPatentSource } = await import('./bigquery-patent-source.mjs');
      const source = createPatentSource();
      return await source.fetchByCpc(cpcCodes);
    } catch {
      return { totalPatents: 0, patents: [] };
    }
  }

  /**
   * Compute all 8 indicators using pure functions from patent-indicators.mjs.
   * Uses computeAllIndicators() which takes raw patentData and returns both axes.
   * Returns values split into certitude and ubiquity axes for aggregation.
   *
   * @param {Object} patentData - Raw patent data from data source
   * @param {string[]} cpcCodes - CPC codes used for the query
   * @returns {Promise<{ certitude: Record<string, number>, ubiquity: Record<string, number> }>}
   */
  async _computeIndicators(patentData, cpcCodes) {
    try {
      const indicators = await import('./patent-indicators.mjs');

      // Build certitude indicator config from strategy config (for toggling)
      const certitudeConfig = Object.entries(this._certitudeIndicators)
        .map(([key, cfg]) => ({ key, weight: cfg.weight, enabled: cfg.enabled }));
      const ubiquiteConfig = Object.entries(this._ubiquityIndicators)
        .map(([key, cfg]) => ({ key, weight: cfg.weight, enabled: cfg.enabled }));

      // Delegate to computeAllIndicators which calls each pure function
      const result = indicators.computeAllIndicators(patentData, {
        certitudeConfig,
        ubiquiteConfig,
      });

      // Extract individual scores into our expected format
      return {
        certitude: {
          convergenceHHI:       result.scores.convergenceHHI ?? 0.5,
          stabiliteTaxonomique: result.scores.stabiliteTaxonomique ?? 0.5,
          densiteCitation:      result.scores.densiteCitation ?? 0.5,
          retrecissementClaims: result.scores.retrecissementClaims ?? 0.5,
        },
        ubiquity: {
          diversiteAssignees:   result.scores.diversiteAssignees ?? 0.5,
          couvertureGeo:        result.scores.couvertureGeo ?? 0.5,
          diffusionSectorielle: result.scores.diffusionSectorielle ?? 0.5,
          ratioExpires:         result.scores.ratioExpires ?? 0.5,
        },
      };
    } catch {
      // Indicator module not available — return neutral defaults
      return {
        certitude: {
          convergenceHHI: 0.5,
          stabiliteTaxonomique: 0.5,
          densiteCitation: 0.5,
          retrecissementClaims: 0.5,
        },
        ubiquity: {
          diversiteAssignees: 0.5,
          couvertureGeo: 0.5,
          diffusionSectorielle: 0.5,
          ratioExpires: 0.5,
        },
      };
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Merge user indicator config overrides with defaults.
 * Preserves default weights/enabled unless explicitly overridden.
 *
 * @param {Record<string, { weight: number, enabled: boolean }>} defaults
 * @param {Record<string, { weight?: number, enabled?: boolean }>} [overrides]
 * @returns {Record<string, { weight: number, enabled: boolean }>}
 */
function mergeIndicatorConfig(defaults, overrides) {
  if (!overrides) return { ...defaults };

  const merged = {};
  for (const [name, defaultCfg] of Object.entries(defaults)) {
    const override = overrides[name] || {};
    merged[name] = {
      weight: override.weight ?? defaultCfg.weight,
      enabled: override.enabled ?? defaultCfg.enabled,
    };
  }
  return merged;
}

// ─── Exports for testing ────────────────────────────────────────────────────

export {
  DEFAULT_CERTITUDE_INDICATORS,
  DEFAULT_UBIQUITY_INDICATORS,
  renormalizeWeights,
  computeDataQuality,
  computeModelConfidence,
  computeConfidence,
  aggregateAxis,
  mergeIndicatorConfig,
};
