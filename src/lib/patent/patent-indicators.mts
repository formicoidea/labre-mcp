// Patent indicators: pure functions computing 8 patent-based evolution signals.
// No I/O — all functions take pre-fetched patent data and return [0, 1] scores.
//
// Split into two axes:
//   CERTITUDE (4 indicators): how well-understood / technically mature
//     1. convergenceHHI      — CPC subclass concentration (HHI)          weight 0.30
//     2. stabiliteTaxonomique — year-over-year CPC code churn             weight 0.20
//     3. densiteCitation      — forward citation density                  weight 0.25
//     4. retrecissementClaims — narrowing of independent claims over time weight 0.25
//
//   UBIQUITÉ (4 indicators): how widespread / adopted
//     5. diversiteAssignees   — unique assignee count → market spread     weight 0.30
//     6. couvertureGeo        — geographic filing breadth (jurisdictions) weight 0.25
//     7. diffusionSectorielle — cross-sector CPC group diversity          weight 0.25
//     8. ratioExpires         — ratio of expired patents (commoditization) weight 0.20

// ─── Default indicator configurations ───────────────────────────────────────────

export const CERTITUDE_INDICATORS = [
  { key: 'convergenceHHI',      weight: 0.30, enabled: true },
  { key: 'stabiliteTaxonomique', weight: 0.20, enabled: true },
  { key: 'densiteCitation',      weight: 0.25, enabled: true },
  { key: 'retrecissementClaims', weight: 0.25, enabled: true },
];

export const UBIQUITE_INDICATORS = [
  { key: 'diversiteAssignees',    weight: 0.30, enabled: true },
  { key: 'couvertureGeo',         weight: 0.25, enabled: true },
  { key: 'diffusionSectorielle',  weight: 0.25, enabled: true },
  { key: 'ratioExpires',          weight: 0.20, enabled: true },
];

// ─── Helper: clamp to [0, 1] ───────────────────────────────────────────────────

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ─── Helper: safe round to 4 decimals ───────────────────────────────────────────

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CERTITUDE INDICATORS (4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 1. Convergence HHI — Herfindahl-Hirschman Index of CPC subclass distribution.
 *
 * High HHI → patents concentrate in few subclasses → technology is converging
 * toward a well-understood domain → high certitude.
 *
 * @param {Array<{cpc: string, count: number}>} cpcDistribution
 *   Each entry: CPC subclass code and patent count assigned to it.
 *   Example: [{ cpc: 'H04L', count: 120 }, { cpc: 'G06F', count: 80 }]
 * @returns {number} Score in [0, 1]. Higher = more concentrated = higher certitude.
 */
export function convergenceHHI(cpcDistribution) {
  if (!Array.isArray(cpcDistribution) || cpcDistribution.length === 0) return 0;

  const total = cpcDistribution.reduce((sum, d) => sum + (d.count || 0), 0);
  if (total === 0) return 0;

  // HHI = sum of squared market shares
  const hhi = cpcDistribution.reduce((sum, d) => {
    const share = (d.count || 0) / total;
    return sum + share * share;
  }, 0);

  // HHI ranges from 1/N (perfectly even) to 1.0 (single class).
  // Normalize: HHI of 1/N → 0 certitude, HHI of 1.0 → 1 certitude.
  const n = cpcDistribution.length;
  if (n <= 1) return 1; // Single class = full convergence

  const hhiMin = 1 / n;
  const normalized = (hhi - hhiMin) / (1 - hhiMin);

  return round4(clamp01(normalized));
}

/**
 * 2. Stabilité taxonomique — year-over-year stability of CPC codes used.
 *
 * Low churn in CPC codes across years → taxonomy is settled → high certitude.
 * Measured as 1 − average Jaccard distance between consecutive year CPC sets.
 *
 * @param {Array<{year: number, cpcCodes: string[]}>} yearlyClassifications
 *   Sorted by year ascending. Each entry: year + set of CPC codes used that year.
 *   Example: [{ year: 2018, cpcCodes: ['H04L', 'G06F'] }, { year: 2019, cpcCodes: ['H04L', 'G06F', 'H04W'] }]
 * @returns {number} Score in [0, 1]. Higher = more stable = higher certitude.
 */
export function stabiliteTaxonomique(yearlyClassifications) {
  if (!Array.isArray(yearlyClassifications) || yearlyClassifications.length < 2) return 0;

  // Sort by year to ensure correct order
  const sorted = [...yearlyClassifications].sort((a, b) => a.year - b.year);

  let totalJaccard = 0;
  let pairs = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Set(sorted[i - 1].cpcCodes || []);
    const curr = new Set(sorted[i].cpcCodes || []);

    if (prev.size === 0 && curr.size === 0) continue;

    // Jaccard similarity = |intersection| / |union|
    const intersection = new Set([...prev].filter(c => curr.has(c)));
    const union = new Set([...prev, ...curr]);

    const jaccard = union.size > 0 ? intersection.size / union.size : 0;
    totalJaccard += jaccard;
    pairs++;
  }

  if (pairs === 0) return 0;

  // Average Jaccard similarity across consecutive year pairs
  return round4(clamp01(totalJaccard / pairs));
}

/**
 * 3. Densité citation — forward citation density (citations received per patent).
 *
 * High forward citations → widely referenced → well-understood technology
 * → high certitude. Normalized via sigmoid to handle heavy-tailed distributions.
 *
 * @param {Object} citationData
 * @param {number} citationData.totalForwardCitations - Total forward citations received
 * @param {number} citationData.patentCount - Number of patents in the CPC class
 * @returns {number} Score in [0, 1]. Higher = more cited = higher certitude.
 */
export function densiteCitation(citationData) {
  if (!citationData || typeof citationData !== 'object') return 0;

  const { totalForwardCitations = 0, patentCount = 0 } = citationData;
  if (patentCount <= 0 || totalForwardCitations <= 0) return 0;

  const avgCitations = totalForwardCitations / patentCount;

  // Sigmoid normalization: midpoint at 10 citations/patent, steepness k=0.3
  // At 0 cit → ~0.05, at 10 cit → 0.5, at 30 cit → ~0.95
  const score = 1 / (1 + Math.exp(-0.3 * (avgCitations - 10)));

  return round4(clamp01(score));
}

/**
 * 4. Rétrécissement claims — narrowing of independent claims over time.
 *
 * When average independent claim count per patent DECREASES over time,
 * technology is maturing (moving from broad exploration to narrow specifics).
 * Higher narrowing → higher certitude.
 *
 * @param {Array<{year: number, avgIndependentClaims: number}>} claimsTimeline
 *   Sorted by year ascending. Each entry: year + average independent claims per patent.
 *   Example: [{ year: 2015, avgIndependentClaims: 8.5 }, { year: 2020, avgIndependentClaims: 4.2 }]
 * @returns {number} Score in [0, 1]. Higher = more narrowing = higher certitude.
 */
export function retrecissementClaims(claimsTimeline) {
  if (!Array.isArray(claimsTimeline) || claimsTimeline.length < 2) return 0;

  const sorted = [...claimsTimeline].sort((a, b) => a.year - b.year);

  // Linear regression: slope of avgIndependentClaims over time
  const n = sorted.length;
  const years = sorted.map(d => d.year);
  const claims = sorted.map(d => d.avgIndependentClaims);

  const meanYear = years.reduce((s, y) => s + y, 0) / n;
  const meanClaims = claims.reduce((s, c) => s + c, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dy = years[i] - meanYear;
    numerator += dy * (claims[i] - meanClaims);
    denominator += dy * dy;
  }

  if (denominator === 0) return 0;

  const slope = numerator / denominator; // claims per year

  // Negative slope = narrowing (good for certitude)
  // Normalize: slope of −1 claims/year → score ~0.73, slope of −2 → ~0.95
  // Using sigmoid centered at slope=0, steepness=2
  // We negate slope so negative slope produces positive input to sigmoid
  const score = 1 / (1 + Math.exp(2 * slope));

  return round4(clamp01(score));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UBIQUITÉ INDICATORS (4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 5. Diversité assignees — unique assignee (patent holder) diversity.
 *
 * More unique assignees → technology widely adopted across organizations
 * → higher ubiquity.
 *
 * @param {Object} assigneeData
 * @param {number} assigneeData.uniqueAssignees - Count of unique assignees
 * @param {number} assigneeData.totalPatents - Total patents in the class
 * @returns {number} Score in [0, 1]. Higher = more diverse = higher ubiquity.
 */
export function diversiteAssignees(assigneeData) {
  if (!assigneeData || typeof assigneeData !== 'object') return 0;

  const { uniqueAssignees = 0, totalPatents = 0 } = assigneeData;
  if (uniqueAssignees <= 0 || totalPatents <= 0) return 0;

  // Ratio of unique assignees to total patents, capped — plus log scaling
  // for large numbers. Midpoint sigmoid at 50 unique assignees.
  const score = 1 / (1 + Math.exp(-0.08 * (uniqueAssignees - 50)));

  return round4(clamp01(score));
}

/**
 * 6. Couverture géographique — geographic filing breadth.
 *
 * More jurisdictions → technology is globally relevant → higher ubiquity.
 *
 * @param {Object} geoData
 * @param {number} geoData.jurisdictionCount - Number of unique patent jurisdictions
 * @param {string[]} [geoData.jurisdictions] - Optional list of jurisdiction codes
 * @returns {number} Score in [0, 1]. Higher = broader coverage = higher ubiquity.
 */
export function couvertureGeo(geoData) {
  if (!geoData || typeof geoData !== 'object') return 0;

  const count = geoData.jurisdictionCount || (geoData.jurisdictions || []).length;
  if (count <= 0) return 0;

  // Major patent offices: ~5 (US, EP, CN, JP, KR). Filing in all 5 = very high.
  // Scale: 1 jurisdiction → ~0.15, 3 → ~0.5, 5 → ~0.8, 10+ → ~0.95
  const score = 1 / (1 + Math.exp(-0.8 * (count - 3)));

  return round4(clamp01(score));
}

/**
 * 7. Diffusion sectorielle — cross-sector CPC group diversity.
 *
 * Patents spanning multiple CPC sections (A–H) → technology diffuses across
 * industries → higher ubiquity.
 *
 * @param {Object} sectorData
 * @param {number} sectorData.uniqueSections - Number of unique CPC sections (A–H, max 9)
 * @param {number} sectorData.uniqueClasses - Number of unique CPC main classes
 * @returns {number} Score in [0, 1]. Higher = more cross-sector = higher ubiquity.
 */
export function diffusionSectorielle(sectorData) {
  if (!sectorData || typeof sectorData !== 'object') return 0;

  const sections = sectorData.uniqueSections || 0;
  const classes = sectorData.uniqueClasses || 0;

  if (sections <= 0) return 0;

  // CPC has 9 sections (A–H + Y). More sections = broader diffusion.
  // Weight: 70% from sections (broad), 30% from class diversity
  const sectionScore = clamp01((sections - 1) / 7); // 1 section → 0, 8 sections → 1
  const classScore = 1 / (1 + Math.exp(-0.15 * (classes - 10))); // midpoint at 10 classes

  const score = 0.7 * sectionScore + 0.3 * classScore;

  return round4(clamp01(score));
}

/**
 * 8. Ratio expirés — proportion of expired patents in the CPC class.
 *
 * A high ratio of expired patents indicates mature, commoditized technology:
 * patents have expired, so the technology is freely available to all → higher ubiquity.
 * Low ratio → most patents still active → technology still proprietary → lower ubiquity.
 *
 * @param {Object} expirationData
 * @param {number} expirationData.expiredCount - Number of expired patents
 * @param {number} expirationData.totalPatents - Total patents (expired + active)
 * @returns {number} Score in [0, 1]. Higher = more expired = higher ubiquity.
 */
export function ratioExpires(expirationData) {
  if (!expirationData || typeof expirationData !== 'object') return 0;

  const { expiredCount = 0, totalPatents = 0 } = expirationData;
  if (totalPatents <= 0 || expiredCount < 0) return 0;

  const ratio = Math.min(expiredCount, totalPatents) / totalPatents;

  // Sigmoid normalization centered at 0.4 (midpoint), steepness k=10
  // ratio 0.0 → ~0.02, ratio 0.2 → ~0.12, ratio 0.4 → 0.5
  // ratio 0.6 → ~0.88, ratio 0.8 → ~0.98
  const score = 1 / (1 + Math.exp(-10 * (ratio - 0.4)));

  return round4(clamp01(score));
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGGREGATION: Weighted mean with toggleable indicators + renormalization
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute weighted mean from indicator scores, respecting enabled/disabled toggles.
 * Disabled indicators are excluded and weights are automatically renormalized.
 *
 * @param {Object} scores - Map of indicator key → score (each in [0, 1])
 * @param {Array<{key: string, weight: number, enabled: boolean}>} indicatorConfig
 *   Indicator definitions with weights and enabled flags.
 * @returns {{ value: number, breakdown: Array<{key: string, score: number, weight: number, weightNormalized: number}>, enabledCount: number }}
 */
export function weightedMean(scores, indicatorConfig) {
  const enabled = indicatorConfig.filter(ind => ind.enabled !== false);

  if (enabled.length === 0) {
    return { value: 0, breakdown: [], enabledCount: 0 };
  }

  // Renormalize weights so enabled indicators sum to 1.0
  const totalWeight = enabled.reduce((sum, ind) => sum + ind.weight, 0);

  let weightedSum = 0;
  const breakdown = [];

  for (const ind of enabled) {
    const score = scores[ind.key] ?? 0;
    const normalizedWeight = totalWeight > 0 ? ind.weight / totalWeight : 0;
    weightedSum += score * normalizedWeight;
    breakdown.push({
      key: ind.key,
      score: round4(score),
      weight: ind.weight,
      weightNormalized: round4(normalizedWeight),
    });
  }

  return {
    value: round4(clamp01(weightedSum)),
    breakdown,
    enabledCount: enabled.length,
  };
}

/**
 * Aggregate 4 certitude indicator scores into a single certitude value.
 *
 * Indicators and default weights:
 *   convergenceHHI:       0.30
 *   stabiliteTaxonomique: 0.20
 *   densiteCitation:      0.25
 *   retrecissementClaims: 0.25
 *
 * @param {Object} scores - Map of certitude indicator key → score (each in [0, 1])
 * @param {Array<{key: string, weight: number, enabled: boolean}>} [config]
 *   Optional custom indicator config (for toggling/reweighting). Defaults to CERTITUDE_INDICATORS.
 * @returns {{ value: number, breakdown: Array, enabledCount: number }}
 */
export function aggregateCertitude(scores, config = CERTITUDE_INDICATORS) {
  return weightedMean(scores, config);
}

/**
 * Aggregate 4 ubiquité indicator scores into a single ubiquité value.
 *
 * Indicators and default weights:
 *   diversiteAssignees:    0.30
 *   couvertureGeo:         0.25
 *   diffusionSectorielle:  0.25
 *   ratioExpires:           0.20
 *
 * @param {Object} scores - Map of ubiquité indicator key → score (each in [0, 1])
 * @param {Array<{key: string, weight: number, enabled: boolean}>} [config]
 *   Optional custom indicator config (for toggling/reweighting). Defaults to UBIQUITE_INDICATORS.
 * @returns {{ value: number, breakdown: Array, enabledCount: number }}
 */
export function aggregateUbiquite(scores, config = UBIQUITE_INDICATORS) {
  return weightedMean(scores, config);
}

/**
 * Compute all 8 indicators from raw patent data and return both axis aggregates.
 *
 * @param {Object} patentData - Pre-fetched patent data containing all needed fields
 * @param {Array} patentData.cpcDistribution - For convergenceHHI
 * @param {Array} patentData.yearlyClassifications - For stabiliteTaxonomique
 * @param {Object} patentData.citationData - For densiteCitation
 * @param {Array} patentData.claimsTimeline - For retrecissementClaims
 * @param {Object} patentData.assigneeData - For diversiteAssignees
 * @param {Object} patentData.geoData - For couvertureGeo
 * @param {Object} patentData.sectorData - For diffusionSectorielle
 * @param {Object} patentData.expirationData - For ratioExpires
 * @param {Object} [options]
 * @param {Array} [options.certitudeConfig] - Custom certitude indicator config
 * @param {Array} [options.ubiquiteConfig] - Custom ubiquité indicator config
 * @returns {{ certitude: {value, breakdown, enabledCount}, ubiquite: {value, breakdown, enabledCount}, scores: Object }}
 */
export function computeAllIndicators(patentData: any, options: any = {}) {
  const {
    certitudeConfig = CERTITUDE_INDICATORS,
    ubiquiteConfig = UBIQUITE_INDICATORS,
  } = options;

  // Compute all 8 individual scores
  const scores = {
    // Certitude axis
    convergenceHHI: convergenceHHI(patentData.cpcDistribution),
    stabiliteTaxonomique: stabiliteTaxonomique(patentData.yearlyClassifications),
    densiteCitation: densiteCitation(patentData.citationData),
    retrecissementClaims: retrecissementClaims(patentData.claimsTimeline),
    // Ubiquité axis
    diversiteAssignees: diversiteAssignees(patentData.assigneeData),
    couvertureGeo: couvertureGeo(patentData.geoData),
    diffusionSectorielle: diffusionSectorielle(patentData.sectorData),
    ratioExpires: ratioExpires(patentData.expirationData),
  };

  return {
    certitude: aggregateCertitude(scores, certitudeConfig),
    ubiquite: aggregateUbiquite(scores, ubiquiteConfig),
    scores,
  };
}
