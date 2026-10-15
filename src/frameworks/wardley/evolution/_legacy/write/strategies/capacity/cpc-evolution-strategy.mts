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
//
// Refusal over default (product-owner decision: a guess must never pass as an
// answer). Mirrors the port in wardley-evolution-benchmark (evaluators/cpc-evolution.ts):
//   - no top-level safety net: a pipeline failure throws instead of returning
//     a neutral (0.5, 0.5) position at confidence 0.1;
//   - a failed CPC mapper, patent source or indicator computation propagates
//     instead of being replaced by [] codes, empty patent data or neutral
//     indicators — each of those stand-ins would feed the position;
//   - no CPC code, or zero patents found, throws: the position would otherwise
//     come from neutral indicators alone.
// Kept: informational fallbacks that do not feed the position (taxonomy cache
// absence → the mapper's LLM path, a null state-of-the-art example, the plain
// .wm insight). Not mirrored: the benchmark's "more than half neutral
// indicators throws" rule — patent-indicators.mts scores missing data itself
// and does not report which indicators had none.

import { BaseStrategy } from './base-strategy.mjs';
import type { ComponentInput, EvolutionResult } from '#types/evolution.mjs';
import { computeEvolution } from '../../s-curve/s-curve.mjs';
import { getCpcTitle } from '../../patent/cpc-taxonomy-cache.mjs';
import type { IndicatorConfig, PatentData, IndicatorResults } from '#types/patent.mjs';
import { getPrompt } from '#lib/prompts/registry.mjs';
import {
  getCurrentCollector,
  runHealthCheck,
  tryDegradeAmbient,
} from '#lib/degradation/index.mjs';

// ─── Response parser (registered in src/lib/prompts/init.mts) ──────────────

/**
 * Parse the cpc-evolution sot-extraction response.
 *
 * Expected format (single line): NAME | DESCRIPTION | EVOLUTION
 * Returns null when the line is missing or malformed. Caps name/description
 * lengths at the values the prompt requests (30 / 40 chars). Does NOT clamp
 * the evolution value — that floor/ceiling is a strategy-level policy applied
 * by the call-site after this parser returns.
 */
export function parseCpcSotExtraction(
  response: string,
): { name: string; description: string; evolution: number | null } | null {
  const match = response.match(/^(.+?)\s*\|\s*(.+?)\s*\|\s*([\d.]+)\s*$/m);
  if (!match) return null;
  const evo = parseFloat(match[3]);
  return {
    name: match[1].trim().substring(0, 30),
    description: match[2].trim().substring(0, 40),
    evolution: Number.isFinite(evo) ? evo : null,
  };
}

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
// any: indicators is a Record<key, {weight, enabled}> internal config shape (not IndicatorConfig[])
function renormalizeWeights(indicators: any): any {
  const enabled = Object.entries(indicators)
    .filter(([, cfg]: [string, any]) => cfg.enabled);

  if (enabled.length === 0) {
    return {};
  }

  const totalWeight = enabled.reduce((sum, [, cfg]: [string, any]) => sum + cfg.weight, 0);

  const normalized: Record<string, number> = {};
  for (const [name, cfg] of enabled as [string, any][]) {
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
function computeDataQuality(patentCount: number): number {
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
function computeModelConfidence(scurveResult: any): number {
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
function computeConfidence(dataQuality: number, modelConfidence: number): number {
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
function aggregateAxis(indicatorValues: any, weights: Record<string, number>) {
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
   * @param {import('#lib/patent/patent-data-source.mjs').PatentDataSource} [options.patentSource]
   *   Patent data source (defaults to BigQueryPatentSource from env vars).
   * @param {import('../../patent/cpc-mapper.mjs').CpcMapper} [options.cpcMapper]
   *   CPC code mapper (defaults to LLM-assisted + hardcoded fallback).
   * @param {Object} [options.config]
   *   Configuration overrides.
   * @param {Record<string, { weight?: number, enabled?: boolean }>} [options.config.certitudeIndicators]
   *   Override certitude indicator weights/toggles.
   * @param {Record<string, { weight?: number, enabled?: boolean }>} [options.config.ubiquityIndicators]
   *   Override ubiquity indicator weights/toggles.
   */
  // any: external dependencies injected via DI — diverse caller shapes
  _llmCall: any;
  _patentSource: any;
  _cpcMapper: any;
  // any: legacy config shape is a Record<string, {weight, enabled}>, not an IndicatorConfig[]
  _certitudeIndicators: any;
  _ubiquityIndicators: any;

  constructor(options: any = {}) {
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
    return 'write:capacity:cpc-evolution';
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
   * **Throws rather than guesses.** No CPC code resolved, zero patents found,
   * or a failure of the mapper, the patent source or the indicators rejects
   * the promise: a neutral (0.5, 0.5) stand-in would place the component
   * mid-axis and pass that guess off as a patent-based answer. Callers (MCP
   * dispatch, recipe fan-out) report the error instead of a fake position.
   *
   * Confidence tiers (when an answer exists):
   *   - <10 patents        → real indicators, confidence 0.25–0.45
   *   - 10–100 patents     → real indicators, confidence 0.45–0.65
   *   - >100 patents       → real indicators, confidence 0.55–0.95
   *
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult & { certitude: number, ubiquity: number }>}
   */
  async evaluate(component: ComponentInput): Promise<EvolutionResult> {
    return this._evaluateInternal(component);
  }

  /**
   * Internal evaluation pipeline.
   *
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult & { certitude: number, ubiquity: number }>}
   * @private
   */
  async _evaluateInternal(component: any): Promise<any> {
    // Step 0: Pre-flight — surface a missing BigQuery configuration up-front
    // rather than letting _fetchPatentData fall back silently. Recorded on
    // the ambient collector (see src/lib/degradation/context.mts) so the MCP
    // result reports degraded:true with the missing env vars.
    const collector = getCurrentCollector();
    if (collector) {
      const bqEvent = await runHealthCheck('bigquery');
      if (bqEvent) {
        collector.record({
          source: bqEvent.source,
          reason: bqEvent.reason,
          severity: bqEvent.severity,
          recoverable: true,
          detail: bqEvent.detail,
        });
      }
    }

    // Step 1: Resolve CPC codes for the component. No code means no patent
    // query: whatever followed would be neutral indicators, i.e. a guess.
    const cpcCodes: string[] = await this._resolveCpcCodes(component);
    if (cpcCodes.length === 0) {
      throw new Error(`cpc-evolution: no CPC code could be resolved for "${component.capability || component.name || ''}"`);
    }

    // Step 2: Fetch patent data. Zero patents would feed only neutral
    // indicators into the S-curve, so it is a refusal, not a low-confidence answer.
    const patentData = await this._fetchPatentData(cpcCodes);
    if (!patentData || !(patentData.totalPatents > 0)) {
      throw new Error(`cpc-evolution: no patent found for CPC ${cpcCodes.join(', ')}`);
    }

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

    // Step 8: Generate .wm pipeline insight
    const cpcTitles = cpcCodes.map((code: string) => ({ code, title: getCpcTitle(code) }));
    const insight = await this._generatePipelineInsight(
      component, scurveResult.evolution, cpcTitles
    );

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
        { step: 'cpc-codes', value: cpcTitles },
        { step: 'patent-count', value: patentCount },
        { step: 'certitude-indicators', value: indicatorValues.certitude, weights: certitudeWeights },
        { step: 'ubiquity-indicators', value: indicatorValues.ubiquity, weights: ubiquityWeights },
        { step: 'aggregated', certitude, ubiquity },
        { step: 's-curve', ...scurveResult },
        { step: 'confidence', dataQuality, modelConfidence, combined: confidence },
        { step: 'insight', value: insight },
      ],
    };

    return BaseStrategy.validateResult(result);
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
  setIndicatorEnabled(axis: string, key: string, enabled: boolean): void {
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
  setIndicatorsEnabled(toggles: any = {}) {
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
      certitude: Object.entries(this._certitudeIndicators).map(([key, cfg]: [string, any]) => ({
        key,
        weight: cfg.weight,
        enabled: cfg.enabled,
        weightNormalized: certitudeWeights[key] ?? 0,
      })),
      ubiquity: Object.entries(this._ubiquityIndicators).map(([key, cfg]: [string, any]) => ({
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

  // ─── Pipeline insight generation ────────────────────────────────────────

  /**
   * Generate a .wm pipeline insight showing the evaluated component
   * within its underlying capability pipeline.
   *
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @param {number} evolution - Computed evolution score
   * @param {Array<{code: string, title: string}>} cpcTitles - CPC codes with titles
   * @returns {Promise<string>} .wm format snippet
   * @private
   */
  async _generatePipelineInsight(component: any, evolution: number, cpcTitles: any): Promise<any> {
    const DEFAULT_VISIBILITY = 0.51;
    const STATE_OF_ART_MIN = 0.85;

    try {
      // 1. Derive capability name from CPC titles or component
      const capabilityName = this._deriveCapabilityName(component, cpcTitles);

      // 2. Ask LLM for a state-of-the-art example
      const stateOfArt = await this._getStateOfArtExample(component, evolution, cpcTitles);

      // 3. Compute positions
      const stateOfArtEvolution = stateOfArt?.evolution ?? Math.max(STATE_OF_ART_MIN, evolution + 0.1);
      const pipelineMin = Math.round(Math.max(0, evolution - 0.05) * 100) / 100;
      const pipelineMax = Math.round(Math.min(1, stateOfArtEvolution + 0.02) * 100) / 100;
      const evoRounded = Math.round(evolution * 1000) / 1000;
      const sotRounded = Math.round(stateOfArtEvolution * 100) / 100;

      // 4. Format component name for .wm (quote if contains spaces)
      const compName = component.name || 'Component';
      const wmCompName = compName.includes(' ') ? `"${compName}"` : compName;

      // 5. Build .wm snippet
      const lines = [
        `component ${capabilityName} [${DEFAULT_VISIBILITY}, ${pipelineMin}] label [-53, -17]`,
        `pipeline ${capabilityName}`,
        `{`,
        `    component ${wmCompName} [${evoRounded}] label [-61, -23]`,
      ];

      if (stateOfArt) {
        const sotName = stateOfArt.name.includes(' ') || stateOfArt.name.includes('"')
          ? `"${stateOfArt.name.replace(/"/g, "'")}"` : stateOfArt.name;
        const sotLabel = stateOfArt.description
          ? `"${stateOfArt.name.replace(/"/g, "'")}\\n${stateOfArt.description.replace(/"/g, "'")}"`
          : sotName;
        lines.push(`    component ${sotLabel} [${sotRounded}] label [-4, 30]`);
      }

      lines.push(`}`);
      return lines.join('\n');
    } catch {
      // Fallback: simple pipeline without state of the art
      const compName = component.name || 'Component';
      const wmCompName = compName.includes(' ') ? `"${compName}"` : compName;
      const evoRounded = Math.round(evolution * 1000) / 1000;
      return [
        `component Capability [${DEFAULT_VISIBILITY}, ${evoRounded}] label [-53, -17]`,
        `pipeline Capability`,
        `{`,
        `    component ${wmCompName} [${evoRounded}] label [-61, -23]`,
        `}`,
      ].join('\n');
    }
  }

  /**
   * Derive a clean capability name from CPC titles or component data.
   * @private
   */
  _deriveCapabilityName(component: any, cpcTitles: any): string {
    // Prefer component.capability if set by identify-capability pipeline
    if (component.capability) {
      const cap = component.capability.trim();
      // Title-case, remove quotes
      const clean = cap.charAt(0).toUpperCase() + cap.slice(1);
      return clean.includes(' ') ? `"${clean}"` : clean;
    }

    // Use first CPC title, cleaned up
    if (cpcTitles.length > 0 && cpcTitles[0].title !== cpcTitles[0].code) {
      let title = cpcTitles[0].title
        .replace(/,?\s*e\.g\..*$/i, '')    // Remove "e.g. ..." suffixes
        .replace(/\s*\[.*?\]/g, '')         // Remove [CPU] style brackets
        .replace(/\s+/g, ' ')
        .trim();
      // Truncate if too long for a .wm component name
      if (title.length > 50) title = title.substring(0, 47) + '...';
      return `"${title}"`;
    }

    return `"${component.name || 'Capability'}"`;
  }

  /**
   * Ask the LLM for a concrete state-of-the-art example in the CPC domain.
   * @private
   */
  async _getStateOfArtExample(component: any, evolution: number, cpcTitles: any): Promise<any> {
    if (!this._llmCall) return null;

    const phase =
      evolution <= 0.18 ? 'Genesis' :
      evolution <= 0.26 ? 'Custom' :
      evolution <= 0.70 ? 'Product' : 'Commodity';

    const cpcContext = cpcTitles
      .map((t: any) => `${t.code}: ${t.title}`)
      .join('\n');

    const p = getPrompt('cpc-evolution', 'sot-extraction');
    const built = p.build({
      cpc_context: cpcContext,
      component_name: component.name || '',
      evolution_score: evolution.toFixed(2),
      phase,
    });

    try {
      const response = await this._llmCall(built.user, undefined, { systemPrompt: built.system });
      const raw = p.parse(response) as { name: string; description: string; evolution: number | null } | null;
      if (raw) {
        return {
          name: raw.name,
          description: raw.description,
          // Clamp policy: SotA evolution cannot be lower than the component's own score.
          evolution: raw.evolution !== null ? Math.max(evolution, Math.min(1, raw.evolution)) : null,
        };
      }
    } catch {
      // LLM failed — return null
    }
    return null;
  }

  // ─── Internal pipeline methods ──────────────────────────────────────────

  /**
   * Resolve CPC codes from component capability via CPC mapper.
   * Uses progressive discovery (LLM + taxonomy cache) when available.
   * A mapper failure propagates: substituting [] codes would end in a
   * neutral-indicator position, i.e. a guess passed off as an answer.
   *
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<string[]>} Array of CPC codes (variable length)
   */
  async _resolveCpcCodes(component: any): Promise<any> {
    if (this._cpcMapper) {
      // Injected mapper (typically tests/mocks). It is the mapper the caller
      // chose: its failure is not silently replaced by the default one.
      const result = await this._cpcMapper.mapToCpc(component);
      return Array.isArray(result) ? result : result?.codes || [];
    }

    const { mapComponentToCpc } = await import('../../patent/cpc-mapper.mjs');
    const { setCpcTitle } = await import('../../patent/cpc-taxonomy-cache.mjs');

    // Try to create taxonomy cache for progressive discovery — its absence
    // is informational only (the mapper falls back to its LLM path), it
    // does not substitute a value for the position.
    const taxonomyCache = await tryDegradeAmbient(
      'cpc-taxonomy-cache',
      async () => {
        const { createTaxonomyCache } = await import('../../patent/cpc-taxonomy-cache.mjs');
        return await createTaxonomyCache();
      },
      null,
    );

    const result = await mapComponentToCpc(component, this._llmCall, { taxonomyCache });

    // Register titles from discovery into the global title store
    if (result.titles) {
      for (const [code, title] of Object.entries(result.titles)) {
        setCpcTitle(code, title as string);
      }
    }

    return result.codes || [];
  }

  /**
   * Fetch patent data from the configured data source (injected, or
   * BigQuery from env vars). A failure propagates: empty patent data in its
   * place would feed neutral indicators into the position.
   *
   * @param {string[]} cpcCodes
   * @returns {Promise<Object>} Patent data object
   */
  async _fetchPatentData(cpcCodes: string[]): Promise<any> {
    if (this._patentSource) {
      return await this._patentSource.fetchByCpc(cpcCodes);
    }

    const { createPatentSource } = await import('#lib/patent/bigquery-patent-source.mjs');
    const source = createPatentSource();
    return await source.fetchByCpc(cpcCodes);
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
  // any: return shape uses 'ubiquity' (legacy) instead of IndicatorResults.ubiquite
  // A failure here propagates: eight neutral 0.5 indicators in its place
  // would put the component mid-axis and call that a patent-based answer.
  async _computeIndicators(patentData: PatentData, cpcCodes: string[]): Promise<any> {
    const indicators = await import('#lib/patent/patent-indicators.mjs');

    // Build certitude indicator config from strategy config (for toggling)
    const certitudeConfig = Object.entries(this._certitudeIndicators)
      .map(([key, cfg]: [string, any]) => ({ key, weight: cfg.weight, enabled: cfg.enabled }));
    const ubiquiteConfig = Object.entries(this._ubiquityIndicators)
      .map(([key, cfg]: [string, any]) => ({ key, weight: cfg.weight, enabled: cfg.enabled }));

    // Delegate to computeAllIndicators which calls each pure function
    const result = indicators.computeAllIndicators(patentData, {
      certitudeConfig,
      ubiquiteConfig,
    });

    // The per-indicator `?? 0.5` is upstream's: each pure function already
    // scores its own missing data, so it only guards a key the result omits.
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
// any: defaults/overrides are Record<key, {weight, enabled}> — not IndicatorConfig[] arrays
function mergeIndicatorConfig(defaults: any, overrides: any): any {
  if (!overrides) return { ...defaults };

  const merged: Record<string, any> = {};
  for (const [name, defaultCfg] of Object.entries(defaults) as [string, any][]) {
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

// ─── Core BaseStrategy adapter ──────────────────────────────────────────────
//
// Wraps the legacy CpcEvolutionStrategy in the core BaseStrategy contract
// (StrategyResult shape, 5-segment methodId). The legacy class above stays
// in place — 13 test/lib files import it directly and rely on its options
// constructor. V1.5 cleanup will consolidate the two surfaces.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { LLMCall } from '#types/llm.mjs';

const NEW_METHOD_ID_CPC = 'wardley:map:climate:position-functional-in-evolution:cpc-evolution';

export class CpcEvolutionStrategyCore extends CoreBaseStrategy<ComponentInput, EvolutionResult> {
  private readonly _llmCall: LLMCall | null;

  constructor(options: { llmCall?: LLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return NEW_METHOD_ID_CPC;
  }

  async evaluate(
    component: ComponentInput,
    _context: RequestContext,
  ): Promise<StrategyResult<EvolutionResult>> {
    const legacy = new CpcEvolutionStrategy(this._llmCall ? { llmCall: this._llmCall } : {});
    // any: legacy result carries certitude/ubiquity/trace on top of EvolutionResult;
    // trace entries are open-shape (each step contributes a different payload).
    const result = await legacy.evaluate(component) as EvolutionResult & {
      certitude?: number;
      ubiquity?: number;
      trace?: Array<Record<string, any>>;
    };
    // Replace the legacy method label with the canonical 5-segment id.
    const wrapped: EvolutionResult = { ...result, method: NEW_METHOD_ID_CPC };

    const capturedAt = new Date().toISOString();
    const signals = [
      ...(component.capability
        ? [{ name: 'capability', value: component.capability, source: 'user-input' as const, capturedAt }]
        : []),
      ...(typeof result.certitude === 'number'
        ? [{ name: 'certitude', value: result.certitude, source: 'cpc-database' as const, capturedAt }]
        : []),
      ...(typeof result.ubiquity === 'number'
        ? [{ name: 'ubiquity', value: result.ubiquity, source: 'cpc-database' as const, capturedAt }]
        : []),
    ];
    // Extract the LLM-generated SotA insight produced by _generatePipelineInsight.
    // any: trace entries are open-shape across the 8 pipeline steps.
    const trace = (result.trace ?? []) as Array<Record<string, any>>;
    const insightStep = trace.find((s) => s.step === 'insight');
    // any: insight payload shape is { name, description, evolution } | null
    const insightValue = insightStep?.value as
      | { name?: string; description?: string; evolution?: number | null }
      | null
      | undefined;
    const insights = insightValue && insightValue.description
      ? [{
          text: insightValue.description,
          by: NEW_METHOD_ID_CPC,
          type: 'historical-context' as const,
        }]
      : [];
    return {
      signals,
      reasoning: [],
      insights,
      result: wrapped,
    };
  }
}
