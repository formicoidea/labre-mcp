// Test: AC 13 — Cross-validation of CPC Evolution Strategy
//
// Validates that the full CPC pipeline (indicators -> aggregation -> computeEvolution)
// maps real-world patent data profiles to the correct Wardley evolution phases:
//
//   B61C (Locomotives)     -> Commodity   (mature, widespread, many expired patents)
//   G06N (AI/ML)           -> Commodity   (massive adoption, global, cross-sector)
//   H10N (Superconductors) -> Genesis     (few patents, narrow, exploratory claims)
//
// Each test uses realistic mock patent data calibrated to reflect the actual
// patent landscape for the given CPC class, injected via mock PatentDataSource
// and CPC mapper (no BigQuery or LLM calls needed).
//
// The test verifies:
//   1. Phase classification matches expected Wardley evolution stage
//   2. Evolution score falls within the correct phase band
//   3. Certitude and ubiquity intermediate values are coherent
//   4. computeEvolution delegation is strict (no custom scoring bypass)
//   5. Confidence model produces bounded [0.1, 0.95] values
//   6. Each technology has a plausible indicator fingerprint

import assert from 'node:assert/strict';
import { computeEvolution } from '../s-curve/s-curve.mjs';
import { CpcEvolutionStrategy } from '../strategies/capacity/cpc-evolution-strategy.mjs';
import { computeAllIndicators } from '#lib/patent/patent-indicators.mjs';

// ── Phase boundary constants (from s-curve.mjs) ──────────────────────────
const PHASE_BOUNDARIES = {
  Genesis:   { min: 0.00, max: 0.18 },
  Custom:    { min: 0.18, max: 0.26 },
  Product:   { min: 0.26, max: 0.70 },
  Commodity: { min: 0.70, max: 1.00 },
};

// ═════════════════════════════════════════════════════════════════════════════
// MOCK PATENT DATA — calibrated to real-world CPC patent landscapes
// ═════════════════════════════════════════════════════════════════════════════

/**
 * B61C — Locomotives (steam, diesel, electric railway traction)
 *
 * Locomotives are a 200+ year technology. Patent landscape:
 * - 3000+ patents across major railway companies (ALSTOM, Siemens, CRRC, Bombardier, GE)
 * - Highly concentrated in B61C with minor overlap into B61D (rolling stock)
 * - Extremely stable taxonomy (same CPC codes for decades)
 * - High forward citation density (well-referenced foundational tech)
 * - Claims narrowing steadily (technology fully refined, incremental improvements)
 * - 300+ unique assignees globally (mature competitive landscape)
 * - Filed in 10+ jurisdictions worldwide
 * - Cross-sector: transportation (B), mechanical (F), electrical (H), physics (G), chemistry (C)
 * - 70% expired ratio (bulk of innovation happened decades ago)
 *
 * Expected: Commodity (evolution > 0.70)
 */
const B61C_LOCOMOTIVE_DATA = {
  totalPatents: 3000,
  cpcDistribution: [
    { cpc: 'B61C', count: 2400 },
    { cpc: 'B61D', count: 600 },
  ],
  yearlyClassifications: [
    { year: 2014, cpcCodes: ['B61C', 'B61D'] },
    { year: 2015, cpcCodes: ['B61C', 'B61D'] },
    { year: 2016, cpcCodes: ['B61C', 'B61D'] },
    { year: 2017, cpcCodes: ['B61C', 'B61D'] },
    { year: 2018, cpcCodes: ['B61C', 'B61D'] },
    { year: 2019, cpcCodes: ['B61C', 'B61D'] },
    { year: 2020, cpcCodes: ['B61C', 'B61D'] },
  ],
  citationData: { totalForwardCitations: 60000, patentCount: 3000 },
  claimsTimeline: [
    { year: 2010, avgIndependentClaims: 9 },
    { year: 2013, avgIndependentClaims: 6 },
    { year: 2016, avgIndependentClaims: 4 },
    { year: 2019, avgIndependentClaims: 3 },
    { year: 2022, avgIndependentClaims: 2.5 },
  ],
  assigneeData: { uniqueAssignees: 300, totalPatents: 3000 },
  geoData: {
    jurisdictionCount: 10,
    jurisdictions: ['US', 'EP', 'CN', 'JP', 'KR', 'IN', 'RU', 'BR', 'CA', 'AU'],
  },
  sectorData: { uniqueSections: 5, uniqueClasses: 20 },
  expirationData: { expiredCount: 2100, totalPatents: 3000 },
};

/**
 * G06N — Computing arrangements based on specific computational models (AI/ML)
 *
 * Neural networks patented since the 1980s. Patent landscape:
 * - 5000+ patents (massive acceleration since 2015)
 * - Highly concentrated in G06N with overflow into G06F (data processing)
 * - Stable taxonomy (G06N established for decades, subclasses settled)
 * - Very high citation density (foundational patents widely referenced)
 * - Claims narrowing from broad "neural network" to specific architectures
 * - 500+ unique assignees (Google, Microsoft, IBM, Baidu, Samsung, startups)
 * - Filed in 12+ jurisdictions (global AI race)
 * - Cross-sector: 6 CPC sections (physics G, electricity H, human necessities A,
 *   operations B, chemistry C, fixed constructions E)
 * - 60% expired ratio (many early neural net patents from 90s-2000s expired)
 *
 * Expected: Commodity (evolution > 0.70)
 */
const G06N_AIML_DATA = {
  totalPatents: 5000,
  cpcDistribution: [
    { cpc: 'G06N', count: 3500 },
    { cpc: 'G06F', count: 1500 },
  ],
  yearlyClassifications: [
    { year: 2015, cpcCodes: ['G06N', 'G06F'] },
    { year: 2016, cpcCodes: ['G06N', 'G06F'] },
    { year: 2017, cpcCodes: ['G06N', 'G06F'] },
    { year: 2018, cpcCodes: ['G06N', 'G06F'] },
    { year: 2019, cpcCodes: ['G06N', 'G06F'] },
    { year: 2020, cpcCodes: ['G06N', 'G06F'] },
    { year: 2021, cpcCodes: ['G06N', 'G06F'] },
  ],
  citationData: { totalForwardCitations: 100000, patentCount: 5000 },
  claimsTimeline: [
    { year: 2012, avgIndependentClaims: 10 },
    { year: 2015, avgIndependentClaims: 7 },
    { year: 2018, avgIndependentClaims: 5 },
    { year: 2021, avgIndependentClaims: 3.5 },
  ],
  assigneeData: { uniqueAssignees: 500, totalPatents: 5000 },
  geoData: {
    jurisdictionCount: 12,
    jurisdictions: ['US', 'EP', 'CN', 'JP', 'KR', 'IN', 'CA', 'AU', 'SG', 'TW', 'IL', 'BR'],
  },
  sectorData: { uniqueSections: 6, uniqueClasses: 25 },
  expirationData: { expiredCount: 3000, totalPatents: 5000 },
};

/**
 * H10N — Superconducting devices (high-temperature superconductors, Josephson devices)
 *
 * Room-temperature superconductors are one of the most actively researched
 * frontiers in physics. Patent landscape:
 * - Only ~12 patents (tiny, highly experimental field)
 * - Spread across 5 CPC classes (H10N, H01L, C01G, C04B, H01B) — no dominant class
 * - Unstable taxonomy (new subclasses being created, classifications shifting yearly)
 * - Very low forward citations (too new to be cited)
 * - Claims BROADENING over time (still exploring design space, not narrowing)
 * - Only 4 unique assignees (mainly national labs and universities)
 * - Filed in 1 jurisdiction only (US)
 * - Single CPC section (H - Electricity)
 * - No expired patents (all filed in last 3-4 years)
 *
 * Expected: Genesis (evolution <= 0.18)
 */
const H10N_SUPERCONDUCTOR_DATA = {
  totalPatents: 12,
  cpcDistribution: [
    { cpc: 'H10N', count: 4 },
    { cpc: 'H01L', count: 3 },
    { cpc: 'C01G', count: 2 },
    { cpc: 'C04B', count: 2 },
    { cpc: 'H01B', count: 1 },
  ],
  yearlyClassifications: [
    { year: 2020, cpcCodes: ['H10N'] },
    { year: 2021, cpcCodes: ['H10N', 'C01G'] },
    { year: 2022, cpcCodes: ['H01L', 'C04B'] },
    { year: 2023, cpcCodes: ['H10N', 'H01L', 'C01G', 'C04B', 'H01B'] },
  ],
  citationData: { totalForwardCitations: 5, patentCount: 12 },
  claimsTimeline: [
    { year: 2020, avgIndependentClaims: 10 },
    { year: 2021, avgIndependentClaims: 13 },
    { year: 2022, avgIndependentClaims: 15 },
    { year: 2023, avgIndependentClaims: 18 },
  ],
  assigneeData: { uniqueAssignees: 4, totalPatents: 12 },
  geoData: { jurisdictionCount: 1, jurisdictions: ['US'] },
  sectorData: { uniqueSections: 1, uniqueClasses: 3 },
  expirationData: { expiredCount: 0, totalPatents: 12 },
};

// ═════════════════════════════════════════════════════════════════════════════
// TEST FIXTURES & HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Create a mock CPC mapper that returns the given CPC code.
 * @param {string} cpcCode - 4-char CPC sub-class code
 */
function createMockCpcMapper(cpcCode) {
  return { mapToCpc: async () => [cpcCode] };
}

/**
 * Create a mock PatentDataSource returning the given data.
 * @param {Object} data - Patent data fixture
 */
function createMockPatentSource(data) {
  return { fetchByCpc: async () => data };
}

/**
 * Create a fully configured CpcEvolutionStrategy for a given CPC test case.
 * @param {string} cpcCode - CPC sub-class code
 * @param {Object} patentData - Mock patent data
 */
function createStrategy(cpcCode, patentData) {
  return new CpcEvolutionStrategy({
    patentSource: createMockPatentSource(patentData),
    cpcMapper: createMockCpcMapper(cpcCode),
  });
}

// ── Test runner ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(1, 3);
      for (const line of lines) console.error(`    ${line.trim()}`);
    }
    failed++;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('=== AC 13: Cross-Validation Tests ===\n');
  console.log('Verifying CPC patent data -> Wardley evolution phase mapping:');
  console.log('  B61C (Locomotives)     -> Commodity');
  console.log('  G06N (AI/ML)           -> Commodity');
  console.log('  H10N (Superconductors) -> Genesis');
  console.log();

  // ═════════════════════════════════════════════════════════════════════════
  // 1. INDICATOR-LEVEL VALIDATION (pure functions, no strategy)
  // ═════════════════════════════════════════════════════════════════════════

  console.log('--- 1. Indicator-Level Validation (pure functions) ---');

  // ── B61C Locomotives: indicator fingerprint ──

  await runTest('B61C indicators: high certitude (convergence, stability, citations, claims narrowing)', () => {
    const r = computeAllIndicators(B61C_LOCOMOTIVE_DATA);

    // Certitude axis: all indicators should be moderate-to-high
    assert.ok(r.scores.stabiliteTaxonomique >= 0.9,
      `B61C taxonomy stability ${r.scores.stabiliteTaxonomique} should be >= 0.9 (decades of stable CPC codes)`);
    assert.ok(r.scores.densiteCitation >= 0.9,
      `B61C citation density ${r.scores.densiteCitation} should be >= 0.9 (well-cited mature tech)`);
    assert.ok(r.scores.retrecissementClaims >= 0.6,
      `B61C claims narrowing ${r.scores.retrecissementClaims} should be >= 0.6 (steady narrowing over decades)`);

    // Aggregate certitude
    assert.ok(r.certitude.value >= 0.6,
      `B61C certitude ${r.certitude.value} should be >= 0.6 (well-understood technology)`);
  });

  await runTest('B61C indicators: high ubiquity (diverse assignees, global, expired)', () => {
    const r = computeAllIndicators(B61C_LOCOMOTIVE_DATA);

    // Ubiquity axis: all indicators should be high
    assert.ok(r.scores.diversiteAssignees >= 0.95,
      `B61C assignee diversity ${r.scores.diversiteAssignees} should be >= 0.95 (300+ assignees)`);
    assert.ok(r.scores.couvertureGeo >= 0.95,
      `B61C geo coverage ${r.scores.couvertureGeo} should be >= 0.95 (10 jurisdictions)`);
    assert.ok(r.scores.ratioExpires >= 0.9,
      `B61C expired ratio ${r.scores.ratioExpires} should be >= 0.9 (70% expired)`);

    // Aggregate ubiquity
    assert.ok(r.ubiquite.value >= 0.8,
      `B61C ubiquity ${r.ubiquite.value} should be >= 0.8 (globally widespread)`);
  });

  // ── G06N AI/ML: indicator fingerprint ──

  await runTest('G06N indicators: high certitude (stable taxonomy, high citations, claims narrowing)', () => {
    const r = computeAllIndicators(G06N_AIML_DATA);

    assert.ok(r.scores.stabiliteTaxonomique >= 0.9,
      `G06N taxonomy stability ${r.scores.stabiliteTaxonomique} should be >= 0.9`);
    assert.ok(r.scores.densiteCitation >= 0.9,
      `G06N citation density ${r.scores.densiteCitation} should be >= 0.9`);
    assert.ok(r.scores.retrecissementClaims >= 0.7,
      `G06N claims narrowing ${r.scores.retrecissementClaims} should be >= 0.7`);

    assert.ok(r.certitude.value >= 0.6,
      `G06N certitude ${r.certitude.value} should be >= 0.6`);
  });

  await runTest('G06N indicators: high ubiquity (massive assignees, global, cross-sector, many expired)', () => {
    const r = computeAllIndicators(G06N_AIML_DATA);

    assert.ok(r.scores.diversiteAssignees >= 0.99,
      `G06N assignee diversity ${r.scores.diversiteAssignees} should be >= 0.99 (500+ assignees)`);
    assert.ok(r.scores.couvertureGeo >= 0.99,
      `G06N geo coverage ${r.scores.couvertureGeo} should be >= 0.99 (12 jurisdictions)`);
    assert.ok(r.scores.diffusionSectorielle >= 0.7,
      `G06N sector diffusion ${r.scores.diffusionSectorielle} should be >= 0.7 (6 sections)`);
    assert.ok(r.scores.ratioExpires >= 0.8,
      `G06N expired ratio ${r.scores.ratioExpires} should be >= 0.8 (60% expired)`);

    assert.ok(r.ubiquite.value >= 0.85,
      `G06N ubiquity ${r.ubiquite.value} should be >= 0.85`);
  });

  // ── H10N Superconductors: indicator fingerprint ──

  await runTest('H10N indicators: low certitude (low convergence, unstable taxonomy, few citations, broadening claims)', () => {
    const r = computeAllIndicators(H10N_SUPERCONDUCTOR_DATA);

    // Certitude axis: all indicators should be very low
    assert.ok(r.scores.convergenceHHI <= 0.1,
      `H10N convergence HHI ${r.scores.convergenceHHI} should be <= 0.1 (spread across many classes)`);
    assert.ok(r.scores.stabiliteTaxonomique <= 0.4,
      `H10N taxonomy stability ${r.scores.stabiliteTaxonomique} should be <= 0.4 (unstable, changing yearly)`);
    assert.ok(r.scores.densiteCitation <= 0.1,
      `H10N citation density ${r.scores.densiteCitation} should be <= 0.1 (too new to be cited)`);
    assert.ok(r.scores.retrecissementClaims <= 0.05,
      `H10N claims narrowing ${r.scores.retrecissementClaims} should be <= 0.05 (claims BROADENING)`);

    // Aggregate certitude must be very low
    assert.ok(r.certitude.value <= 0.15,
      `H10N certitude ${r.certitude.value} should be <= 0.15 (poorly understood frontier tech)`);
  });

  await runTest('H10N indicators: low ubiquity (few assignees, single jurisdiction, no expired)', () => {
    const r = computeAllIndicators(H10N_SUPERCONDUCTOR_DATA);

    // Ubiquity axis: all indicators should be very low
    assert.ok(r.scores.diversiteAssignees <= 0.05,
      `H10N assignee diversity ${r.scores.diversiteAssignees} should be <= 0.05 (4 assignees only)`);
    assert.ok(r.scores.couvertureGeo <= 0.2,
      `H10N geo coverage ${r.scores.couvertureGeo} should be <= 0.2 (1 jurisdiction)`);
    assert.ok(r.scores.diffusionSectorielle <= 0.15,
      `H10N sector diffusion ${r.scores.diffusionSectorielle} should be <= 0.15 (1 section)`);
    assert.ok(r.scores.ratioExpires <= 0.02,
      `H10N expired ratio ${r.scores.ratioExpires} should be <= 0.02 (0 expired patents)`);

    // Aggregate ubiquity must be very low
    assert.ok(r.ubiquite.value <= 0.15,
      `H10N ubiquity ${r.ubiquite.value} should be <= 0.15 (niche, not widespread)`);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. S-CURVE MODEL VALIDATION (certitude, ubiquity -> phase)
  // ═════════════════════════════════════════════════════════════════════════

  console.log('\n--- 2. S-Curve Model Phase Validation ---');

  await runTest('B61C (certitude, ubiquity) maps to Commodity via computeEvolution', () => {
    const r = computeAllIndicators(B61C_LOCOMOTIVE_DATA);
    const evo = computeEvolution(r.certitude.value, r.ubiquite.value);

    assert.equal(evo.phase, 'Commodity',
      `B61C: (c=${r.certitude.value}, u=${r.ubiquite.value}) -> ${evo.phase} (expected Commodity)`);
    assert.ok(evo.evolution > PHASE_BOUNDARIES.Commodity.min,
      `B61C evolution ${evo.evolution} should be > ${PHASE_BOUNDARIES.Commodity.min}`);
  });

  await runTest('G06N (certitude, ubiquity) maps to Commodity via computeEvolution', () => {
    const r = computeAllIndicators(G06N_AIML_DATA);
    const evo = computeEvolution(r.certitude.value, r.ubiquite.value);

    assert.equal(evo.phase, 'Commodity',
      `G06N: (c=${r.certitude.value}, u=${r.ubiquite.value}) -> ${evo.phase} (expected Commodity)`);
    assert.ok(evo.evolution > PHASE_BOUNDARIES.Commodity.min,
      `G06N evolution ${evo.evolution} should be > ${PHASE_BOUNDARIES.Commodity.min}`);
  });

  await runTest('H10N (certitude, ubiquity) maps to Genesis via computeEvolution', () => {
    const r = computeAllIndicators(H10N_SUPERCONDUCTOR_DATA);
    const evo = computeEvolution(r.certitude.value, r.ubiquite.value);

    assert.equal(evo.phase, 'Genesis',
      `H10N: (c=${r.certitude.value}, u=${r.ubiquite.value}) -> ${evo.phase} (expected Genesis)`);
    assert.ok(evo.evolution <= PHASE_BOUNDARIES.Genesis.max,
      `H10N evolution ${evo.evolution} should be <= ${PHASE_BOUNDARIES.Genesis.max}`);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3. END-TO-END STRATEGY VALIDATION
  // ═════════════════════════════════════════════════════════════════════════

  console.log('\n--- 3. End-to-End Strategy Pipeline ---');

  // ── B61C Locomotives -> Commodity ──

  await runTest('B61C end-to-end: strategy.evaluate() -> Commodity phase', async () => {
    const strategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const result = await strategy.evaluate({
      name: 'Locomotive Engine',
      capability: 'railway traction',
    });

    const scurveStep = result.trace.find(t => t.step === 's-curve');
    assert.ok(scurveStep, 'B61C result trace must include s-curve step');
    assert.equal(scurveStep.phase, 'Commodity',
      `B61C strategy phase: ${scurveStep.phase} (expected Commodity)`);
    assert.ok(result.evolution > 0.70,
      `B61C evolution ${result.evolution} should be > 0.70 (Commodity threshold)`);
  });

  await runTest('B61C end-to-end: valid EvolutionResult shape', async () => {
    const strategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const result = await strategy.evaluate({ name: 'Locomotive Engine' });

    assert.equal(result.method, 'cpc-evolution');
    assert.equal(typeof result.evolution, 'number');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.certitude, 'number');
    assert.equal(typeof result.ubiquity, 'number');
    assert.ok(Array.isArray(result.trace));
    assert.ok(result.evolution >= 0 && result.evolution <= 1);
    assert.ok(result.confidence >= 0.1 && result.confidence <= 0.95);
    assert.ok(result.certitude >= 0 && result.certitude <= 1);
    assert.ok(result.ubiquity >= 0 && result.ubiquity <= 1);
  });

  await runTest('B61C end-to-end: high confidence (abundant data, >100 patents)', async () => {
    const strategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const result = await strategy.evaluate({ name: 'Locomotive Engine' });

    // 3000 patents -> dataQuality >= 0.7, model in-band -> confidence >= 0.7
    assert.ok(result.confidence >= 0.7,
      `B61C confidence ${result.confidence} should be >= 0.7 (3000 patents, in-band)`);
  });

  // ── G06N AI/ML -> Commodity ──

  await runTest('G06N end-to-end: strategy.evaluate() -> Commodity phase', async () => {
    const strategy = createStrategy('G06N', G06N_AIML_DATA);
    const result = await strategy.evaluate({
      name: 'Machine Learning',
      capability: 'neural network training',
    });

    const scurveStep = result.trace.find(t => t.step === 's-curve');
    assert.ok(scurveStep, 'G06N result trace must include s-curve step');
    assert.equal(scurveStep.phase, 'Commodity',
      `G06N strategy phase: ${scurveStep.phase} (expected Commodity)`);
    assert.ok(result.evolution > 0.70,
      `G06N evolution ${result.evolution} should be > 0.70 (Commodity threshold)`);
  });

  await runTest('G06N end-to-end: valid EvolutionResult shape', async () => {
    const strategy = createStrategy('G06N', G06N_AIML_DATA);
    const result = await strategy.evaluate({ name: 'Machine Learning' });

    assert.equal(result.method, 'cpc-evolution');
    assert.equal(typeof result.evolution, 'number');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.certitude, 'number');
    assert.equal(typeof result.ubiquity, 'number');
    assert.ok(Array.isArray(result.trace));
  });

  await runTest('G06N end-to-end: high confidence (abundant data)', async () => {
    const strategy = createStrategy('G06N', G06N_AIML_DATA);
    const result = await strategy.evaluate({ name: 'Machine Learning' });

    assert.ok(result.confidence >= 0.7,
      `G06N confidence ${result.confidence} should be >= 0.7 (5000 patents)`);
  });

  // ── H10N Superconductors -> Genesis ──

  await runTest('H10N end-to-end: strategy.evaluate() -> Genesis phase', async () => {
    const strategy = createStrategy('H10N', H10N_SUPERCONDUCTOR_DATA);
    const result = await strategy.evaluate({
      name: 'Room-Temperature Superconductor',
      capability: 'high-Tc superconductivity',
    });

    const scurveStep = result.trace.find(t => t.step === 's-curve');
    assert.ok(scurveStep, 'H10N result trace must include s-curve step');
    assert.equal(scurveStep.phase, 'Genesis',
      `H10N strategy phase: ${scurveStep.phase} (expected Genesis)`);
    assert.ok(result.evolution <= 0.18,
      `H10N evolution ${result.evolution} should be <= 0.18 (Genesis threshold)`);
  });

  await runTest('H10N end-to-end: valid EvolutionResult with low confidence', async () => {
    const strategy = createStrategy('H10N', H10N_SUPERCONDUCTOR_DATA);
    const result = await strategy.evaluate({ name: 'Room-Temperature Superconductor' });

    assert.equal(result.method, 'cpc-evolution');
    assert.equal(typeof result.evolution, 'number');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.certitude, 'number');
    assert.equal(typeof result.ubiquity, 'number');
    assert.ok(Array.isArray(result.trace));

    // 12 patents -> low data quality -> confidence should be lower than mature techs
    assert.ok(result.confidence <= 0.6,
      `H10N confidence ${result.confidence} should be <= 0.6 (only 12 patents)`);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 4. COMPUTEEVOLUTION DELEGATION VERIFICATION
  // ═════════════════════════════════════════════════════════════════════════

  console.log('\n--- 4. computeEvolution Delegation Verification ---');

  await runTest('B61C: strategy evolution === computeEvolution(certitude, ubiquity)', async () => {
    const strategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const result = await strategy.evaluate({ name: 'Locomotive Engine' });

    const expected = computeEvolution(result.certitude, result.ubiquity);
    assert.strictEqual(result.evolution, expected.evolution,
      `B61C: evolution ${result.evolution} !== computeEvolution(${result.certitude}, ${result.ubiquity}) = ${expected.evolution}`);
  });

  await runTest('G06N: strategy evolution === computeEvolution(certitude, ubiquity)', async () => {
    const strategy = createStrategy('G06N', G06N_AIML_DATA);
    const result = await strategy.evaluate({ name: 'Machine Learning' });

    const expected = computeEvolution(result.certitude, result.ubiquity);
    assert.strictEqual(result.evolution, expected.evolution,
      `G06N: evolution ${result.evolution} !== computeEvolution(${result.certitude}, ${result.ubiquity}) = ${expected.evolution}`);
  });

  await runTest('H10N: strategy evolution === computeEvolution(certitude, ubiquity)', async () => {
    const strategy = createStrategy('H10N', H10N_SUPERCONDUCTOR_DATA);
    const result = await strategy.evaluate({ name: 'Room-Temperature Superconductor' });

    const expected = computeEvolution(result.certitude, result.ubiquity);
    assert.strictEqual(result.evolution, expected.evolution,
      `H10N: evolution ${result.evolution} !== computeEvolution(${result.certitude}, ${result.ubiquity}) = ${expected.evolution}`);
  });

  await runTest('All three: no custom scoring bypass (strict delegation)', async () => {
    const cases = [
      { cpc: 'B61C', data: B61C_LOCOMOTIVE_DATA, name: 'Locomotive' },
      { cpc: 'G06N', data: G06N_AIML_DATA, name: 'AI/ML' },
      { cpc: 'H10N', data: H10N_SUPERCONDUCTOR_DATA, name: 'Superconductor' },
    ];

    for (const { cpc, data, name } of cases) {
      const strategy = createStrategy(cpc, data);
      const result = await strategy.evaluate({ name });
      const expected = computeEvolution(result.certitude, result.ubiquity);

      assert.strictEqual(result.evolution, expected.evolution,
        `${cpc} (${name}): custom scoring bypass detected — ` +
        `strategy.evolution=${result.evolution} !== computeEvolution(${result.certitude}, ${result.ubiquity}).evolution=${expected.evolution}`);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 5. RELATIVE ORDERING VALIDATION
  // ═════════════════════════════════════════════════════════════════════════

  console.log('\n--- 5. Relative Ordering (Commodity > Genesis) ---');

  await runTest('Commodity technologies have higher evolution than Genesis', async () => {
    const locoStrategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const aimlStrategy = createStrategy('G06N', G06N_AIML_DATA);
    const scStrategy = createStrategy('H10N', H10N_SUPERCONDUCTOR_DATA);

    const locoResult = await locoStrategy.evaluate({ name: 'Locomotive Engine' });
    const aimlResult = await aimlStrategy.evaluate({ name: 'Machine Learning' });
    const scResult = await scStrategy.evaluate({ name: 'Superconductor' });

    // Both Commodity technologies should have evolution > Genesis
    assert.ok(locoResult.evolution > scResult.evolution,
      `B61C evolution (${locoResult.evolution}) should be > H10N evolution (${scResult.evolution})`);
    assert.ok(aimlResult.evolution > scResult.evolution,
      `G06N evolution (${aimlResult.evolution}) should be > H10N evolution (${scResult.evolution})`);

    // Both certitude values should reflect maturity ordering
    assert.ok(locoResult.certitude > scResult.certitude,
      `B61C certitude (${locoResult.certitude}) should be > H10N certitude (${scResult.certitude})`);
    assert.ok(aimlResult.certitude > scResult.certitude,
      `G06N certitude (${aimlResult.certitude}) should be > H10N certitude (${scResult.certitude})`);

    // Both ubiquity values should reflect adoption ordering
    assert.ok(locoResult.ubiquity > scResult.ubiquity,
      `B61C ubiquity (${locoResult.ubiquity}) should be > H10N ubiquity (${scResult.ubiquity})`);
    assert.ok(aimlResult.ubiquity > scResult.ubiquity,
      `G06N ubiquity (${aimlResult.ubiquity}) should be > H10N ubiquity (${scResult.ubiquity})`);
  });

  await runTest('Commodity technologies have higher confidence than Genesis', async () => {
    const locoStrategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const scStrategy = createStrategy('H10N', H10N_SUPERCONDUCTOR_DATA);

    const locoResult = await locoStrategy.evaluate({ name: 'Locomotive Engine' });
    const scResult = await scStrategy.evaluate({ name: 'Superconductor' });

    // More data → higher confidence (3000 patents vs 12)
    assert.ok(locoResult.confidence > scResult.confidence,
      `B61C confidence (${locoResult.confidence}) should be > H10N confidence (${scResult.confidence})`);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 6. CERTITUDE/UBIQUITY COHERENCE CHECKS
  // ═════════════════════════════════════════════════════════════════════════

  console.log('\n--- 6. Certitude/Ubiquity Coherence ---');

  await runTest('B61C: certitude and ubiquity are both high (well-understood + widespread)', async () => {
    const strategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const result = await strategy.evaluate({ name: 'Locomotive Engine' });

    assert.ok(result.certitude >= 0.6,
      `B61C certitude ${result.certitude} should be >= 0.6 (well-understood tech)`);
    assert.ok(result.ubiquity >= 0.8,
      `B61C ubiquity ${result.ubiquity} should be >= 0.8 (globally widespread)`);
  });

  await runTest('G06N: certitude and ubiquity are both high', async () => {
    const strategy = createStrategy('G06N', G06N_AIML_DATA);
    const result = await strategy.evaluate({ name: 'Machine Learning' });

    assert.ok(result.certitude >= 0.6,
      `G06N certitude ${result.certitude} should be >= 0.6`);
    assert.ok(result.ubiquity >= 0.8,
      `G06N ubiquity ${result.ubiquity} should be >= 0.8`);
  });

  await runTest('H10N: certitude and ubiquity are both very low', async () => {
    const strategy = createStrategy('H10N', H10N_SUPERCONDUCTOR_DATA);
    const result = await strategy.evaluate({ name: 'Room-Temperature Superconductor' });

    assert.ok(result.certitude <= 0.15,
      `H10N certitude ${result.certitude} should be <= 0.15 (poorly understood)`);
    assert.ok(result.ubiquity <= 0.15,
      `H10N ubiquity ${result.ubiquity} should be <= 0.15 (not widespread)`);
  });

  await runTest('trace aggregated step matches result certitude/ubiquity for all three', async () => {
    const cases = [
      { cpc: 'B61C', data: B61C_LOCOMOTIVE_DATA, name: 'Locomotive' },
      { cpc: 'G06N', data: G06N_AIML_DATA, name: 'AI/ML' },
      { cpc: 'H10N', data: H10N_SUPERCONDUCTOR_DATA, name: 'Superconductor' },
    ];

    for (const { cpc, data, name } of cases) {
      const strategy = createStrategy(cpc, data);
      const result = await strategy.evaluate({ name });
      const aggStep = result.trace.find(t => t.step === 'aggregated');

      assert.ok(aggStep, `${cpc} trace must contain aggregated step`);
      assert.strictEqual(aggStep.certitude, result.certitude,
        `${cpc}: trace certitude ${aggStep.certitude} !== result.certitude ${result.certitude}`);
      assert.strictEqual(aggStep.ubiquity, result.ubiquity,
        `${cpc}: trace ubiquity ${aggStep.ubiquity} !== result.ubiquity ${result.ubiquity}`);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 7. CONFIDENCE MODEL CROSS-CHECK
  // ═════════════════════════════════════════════════════════════════════════

  console.log('\n--- 7. Confidence Model Cross-Check ---');

  await runTest('confidence trace step present for all three technologies', async () => {
    const cases = [
      { cpc: 'B61C', data: B61C_LOCOMOTIVE_DATA, name: 'Locomotive' },
      { cpc: 'G06N', data: G06N_AIML_DATA, name: 'AI/ML' },
      { cpc: 'H10N', data: H10N_SUPERCONDUCTOR_DATA, name: 'Superconductor' },
    ];

    for (const { cpc, data, name } of cases) {
      const strategy = createStrategy(cpc, data);
      const result = await strategy.evaluate({ name });
      const confStep = result.trace.find(t => t.step === 'confidence');

      assert.ok(confStep, `${cpc} trace must contain confidence step`);
      assert.equal(typeof confStep.dataQuality, 'number',
        `${cpc} confidence step missing dataQuality`);
      assert.equal(typeof confStep.modelConfidence, 'number',
        `${cpc} confidence step missing modelConfidence`);
      assert.equal(typeof confStep.combined, 'number',
        `${cpc} confidence step missing combined`);
    }
  });

  await runTest('data quality scales with patent count across technologies', async () => {
    const cases = [
      { cpc: 'H10N', data: H10N_SUPERCONDUCTOR_DATA, patents: 12 },   // low
      { cpc: 'B61C', data: B61C_LOCOMOTIVE_DATA, patents: 3000 },      // high
      { cpc: 'G06N', data: G06N_AIML_DATA, patents: 5000 },            // highest
    ];

    const qualities = [];
    for (const { cpc, data } of cases) {
      const strategy = createStrategy(cpc, data);
      const result = await strategy.evaluate({ name: 'Test' });
      const confStep = result.trace.find(t => t.step === 'confidence');
      qualities.push({ cpc, dq: confStep.dataQuality });
    }

    // Data quality should increase with patent count
    assert.ok(qualities[0].dq < qualities[1].dq,
      `H10N dataQuality (${qualities[0].dq}) should be < B61C (${qualities[1].dq})`);
    assert.ok(qualities[1].dq <= qualities[2].dq,
      `B61C dataQuality (${qualities[1].dq}) should be <= G06N (${qualities[2].dq})`);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 8. EVOLUTION SEPARATION MAGNITUDE
  // ═════════════════════════════════════════════════════════════════════════

  console.log('\n--- 8. Evolution Separation Magnitude ---');

  await runTest('Commodity and Genesis evolutions are well-separated (delta > 0.5)', async () => {
    const locoStrategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const scStrategy = createStrategy('H10N', H10N_SUPERCONDUCTOR_DATA);

    const locoResult = await locoStrategy.evaluate({ name: 'Locomotive' });
    const scResult = await scStrategy.evaluate({ name: 'Superconductor' });

    const delta = locoResult.evolution - scResult.evolution;
    assert.ok(delta > 0.5,
      `Evolution separation between B61C (${locoResult.evolution}) and H10N (${scResult.evolution}) ` +
      `should be > 0.5, got delta=${delta.toFixed(3)}`);
  });

  await runTest('Both Commodity technologies are in same phase band', async () => {
    const locoStrategy = createStrategy('B61C', B61C_LOCOMOTIVE_DATA);
    const aimlStrategy = createStrategy('G06N', G06N_AIML_DATA);

    const locoResult = await locoStrategy.evaluate({ name: 'Locomotive' });
    const aimlResult = await aimlStrategy.evaluate({ name: 'AI/ML' });

    // Both should be in [0.70, 1.0] (Commodity)
    assert.ok(locoResult.evolution >= 0.70 && locoResult.evolution <= 1.0,
      `B61C evolution ${locoResult.evolution} should be in Commodity band [0.70, 1.0]`);
    assert.ok(aimlResult.evolution >= 0.70 && aimlResult.evolution <= 1.0,
      `G06N evolution ${aimlResult.evolution} should be in Commodity band [0.70, 1.0]`);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═════════════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(60)}`);
  console.log(`AC 13 Cross-Validation: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(60)}`);

  if (failed > 0) {
    console.error('\n\u2717 AC 13 cross-validation tests FAILED\n');
    process.exit(1);
  } else {
    console.log('\n\u2713 All AC 13 cross-validation tests PASSED');
    console.log('  B61C (Locomotives)     -> Commodity \u2713');
    console.log('  G06N (AI/ML)           -> Commodity \u2713');
    console.log('  H10N (Superconductors) -> Genesis   \u2713');
    console.log();
  }
}

main().catch(err => {
  console.error('\n\u2717 AC 13 cross-validation tests CRASHED:', err);
  process.exit(1);
});
