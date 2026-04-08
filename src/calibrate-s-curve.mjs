// Offline calibration: compare pub_evolution vs scurve_evolution across PromptFoo results
// Usage: npx promptfoo eval --output results.json && node scripts/calibrate-s-curve.mjs results.json
//
// Reads PromptFoo eval output, extracts (scurve_evolution, pub_evolution) pairs,
// computes residuals per phase, and reports calibration diagnostics.

import { readFile } from 'node:fs/promises';
import { computeEvolution, PUB_TYPE_CENTROIDS, pubEvolution, DEFAULT_PARAMS } from './s-curve.mjs';

const file = process.argv[2] || 'results.json';

const raw = await readFile(file, 'utf-8');
const data = JSON.parse(raw);

// PromptFoo output shape: { results: { results: [ { response: { output }, vars } ] } }
const results = data.results?.results ?? data.results ?? [];

const pairs = [];

for (const r of results) {
  let parsed;
  try {
    const output = typeof r.response?.output === 'string' ? r.response.output : JSON.stringify(r.response?.output);
    parsed = JSON.parse(output.trim());
  } catch {
    continue;
  }

  if (parsed.scurve_evolution == null || parsed.pub_evolution == null) continue;

  const phase =
    parsed.scurve_evolution <= 0.18 ? 'Genesis' :
    parsed.scurve_evolution <= 0.40 ? 'Custom' :
    parsed.scurve_evolution <= 0.70 ? 'Product' :
    'Commodity';

  pairs.push({
    component: r.vars?.component ?? '?',
    scurve: parsed.scurve_evolution,
    pub: parsed.pub_evolution,
    llm: parsed.llm_evolution,
    residual: parsed.pub_evolution - parsed.scurve_evolution,
    phase,
    proportions: parsed.pub_proportions,
  });
}

if (pairs.length === 0) {
  console.log('No valid (scurve_evolution, pub_evolution) pairs found.');
  console.log(`Checked ${results.length} results in ${file}`);
  process.exit(1);
}

// Global stats
const residuals = pairs.map(p => p.residual);
const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
const variance = residuals.reduce((a, r) => a + (r - mean) ** 2, 0) / residuals.length;
const stdDev = Math.sqrt(variance);
const mae = residuals.reduce((a, r) => a + Math.abs(r), 0) / residuals.length;

console.log('═══════════════════════════════════════════════════');
console.log('  S-Curve Calibration Report (pub vs scurve)');
console.log('═══════════════════════════════════════════════════');
console.log(`  Pairs:         ${pairs.length}`);
console.log(`  Mean residual: ${mean.toFixed(4)} (>0 = s-curve underestimates)`);
console.log(`  Std dev:       ${stdDev.toFixed(4)}`);
console.log(`  MAE:           ${mae.toFixed(4)}`);
console.log();

// Per-phase breakdown
const phases = ['Genesis', 'Custom', 'Product', 'Commodity'];
for (const phase of phases) {
  const phaseResiduals = pairs.filter(p => p.phase === phase).map(p => p.residual);
  if (phaseResiduals.length === 0) {
    console.log(`  ${phase.padEnd(12)} — no data`);
    continue;
  }
  const pMean = phaseResiduals.reduce((a, b) => a + b, 0) / phaseResiduals.length;
  const pMae = phaseResiduals.reduce((a, r) => a + Math.abs(r), 0) / phaseResiduals.length;
  console.log(`  ${phase.padEnd(12)} n=${String(phaseResiduals.length).padEnd(3)} mean=${pMean.toFixed(4).padStart(8)}  MAE=${pMae.toFixed(4)}`);
}

console.log();
console.log('─── Per-component detail ────────────────────────');
for (const p of pairs) {
  const arrow = p.residual > 0 ? '↑' : p.residual < 0 ? '↓' : '=';
  console.log(
    `  ${p.component.padEnd(20)} scurve=${p.scurve.toFixed(3)}  pub=${p.pub.toFixed(3)}  Δ=${p.residual.toFixed(3)} ${arrow}  [${p.phase}]`
  );
}

console.log();
console.log('─── Interpretation ─────────────────────────────');
if (Math.abs(mean) < 0.05) {
  console.log('  ✓ Global residual is small — s-curve parameters are well calibrated.');
} else if (mean > 0) {
  console.log('  ⚠ Positive mean residual — s-curve underestimates evolution.');
  console.log('    Consider: lower x0Upper/x0Lower or increase kUpper/kLower.');
} else {
  console.log('  ⚠ Negative mean residual — s-curve overestimates evolution.');
  console.log('    Consider: raise x0Upper/x0Lower or decrease kUpper/kLower.');
}

console.log();
console.log('Current DEFAULT_PARAMS:', JSON.stringify(DEFAULT_PARAMS, null, 2));
console.log('PUB_TYPE_CENTROIDS:', JSON.stringify(PUB_TYPE_CENTROIDS, null, 2));
