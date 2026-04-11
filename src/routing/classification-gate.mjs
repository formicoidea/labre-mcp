// Classification gate: pre-filters Wardley Map components by economic space
//
// Three spaces (from Wardley's model extended to social/common goods):
//   - social_good:  Naturally available resources not produced or traded in markets
//                   (e.g. air, sunlight, gravity). Evolution < 0 in extended model.
//   - common_good:  Shared resources managed collectively, beyond pure market logic
//                   (e.g. open-source standards once fully commodified, Wikipedia).
//                   Evolution > 1 in extended model.
//   - economic:     Components that participate in market dynamics — the standard
//                   Wardley evolution axis [0, 1].
//
// The gate is FIXED and NON-PLUGGABLE (single implementation by design).
// Components classified as social_good or common_good trigger user re-questioning
// rather than proceeding to evolution evaluation.

/**
 * @typedef {Object} ClassificationResult
 * @property {'social_good' | 'common_good' | 'economic'} space
 * @property {string}  reason      - Human-readable explanation
 * @property {boolean} requiresReQuestion - true if the user should be re-questioned
 */

// ─── Indicator keyword lists ───────────────────────────────────────────────

const SOCIAL_GOOD_INDICATORS = [
  // Natural / atmospheric / geological
  'air', 'oxygen', 'atmosphere', 'atmospheric', 'sunlight', 'sunshine',
  'daylight', 'gravity', 'wind', 'rain', 'rainfall', 'weather',
  'ocean current', 'tide', 'tidal',
  // Fundamental natural resources (unowned)
  'breathable air', 'fresh air', 'natural light',
  'cosmic radiation', 'magnetosphere',
  // Biological commons
  'photosynthesis', 'pollination', 'natural pollination',
  'biodiversity', 'ecosystem service',
];

const COMMON_GOOD_INDICATORS = [
  // Knowledge / cultural commons
  'public domain', 'open knowledge', 'open data',
  'public education', 'universal education',
  'public health system', 'universal healthcare',
  'public infrastructure', 'public road', 'public highway',
  // Digital commons
  'creative commons', 'open standard',
  // Governance
  'rule of law', 'democracy', 'public safety',
  'national defense', 'public defense',
];

// Contextual signals that reinforce social good classification
const SOCIAL_CONTEXT_SIGNALS = [
  'freely available', 'naturally occurring', 'no cost',
  'ubiquitous by nature', 'not produced', 'not manufactured',
  'available to all', 'grows naturally', 'grow crops',
  'natural resource', 'cannot be owned', 'non-excludable',
  'non-rivalrous', 'atmospheric', 'environmental',
];

// Contextual signals that reinforce common good classification
const COMMON_CONTEXT_SIGNALS = [
  'collectively managed', 'public ownership', 'shared resource',
  'community owned', 'government provided', 'taxpayer funded',
  'social ownership', 'decommodified', 'post-commodity',
  'universal access', 'public provision',
];

// ─── Classification logic ──────────────────────────────────────────────────

/**
 * Normalize text for matching: lowercase, collapse whitespace, trim.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Count how many indicators from a list appear in the given text.
 * @param {string} text
 * @param {string[]} indicators
 * @returns {{ count: number, matched: string[] }}
 */
function matchIndicators(text, indicators) {
  const matched = indicators.filter(ind => text.includes(ind));
  return { count: matched.length, matched };
}

/**
 * Classify a component into an economic space.
 *
 * @param {string} componentName - The component name (e.g. "Air")
 * @param {string} context       - Business / usage context
 * @returns {ClassificationResult}
 */
export function classifyComponent(componentName, context = '') {
  const name = normalize(componentName);
  const ctx  = normalize(context);
  const combined = `${name} ${ctx}`;

  // ── Social good detection ──────────────────────────────────────────────

  const socialName    = matchIndicators(name, SOCIAL_GOOD_INDICATORS);
  const socialCtx     = matchIndicators(ctx, SOCIAL_CONTEXT_SIGNALS);
  const socialCombined = matchIndicators(combined, SOCIAL_GOOD_INDICATORS);

  // Strong match: component name IS a social good indicator
  if (socialName.count > 0) {
    return {
      space: 'social_good',
      reason: `"${componentName}" is a naturally available resource (matched: ${socialName.matched.join(', ')}). ` +
              `Social goods exist outside the economic space and cannot be meaningfully placed on the Wardley evolution axis.`,
      requiresReQuestion: true,
    };
  }

  // Context-reinforced match: combined text has social good indicators + context signals
  if (socialCombined.count > 0 && socialCtx.count > 0) {
    return {
      space: 'social_good',
      reason: `"${componentName}" in this context appears to be a social good ` +
              `(indicators: ${socialCombined.matched.join(', ')}; context signals: ${socialCtx.matched.join(', ')}). ` +
              `Social goods require re-framing before evolution evaluation.`,
      requiresReQuestion: true,
    };
  }

  // Pure context signal saturation (>=2 signals without direct indicator match)
  if (socialCtx.count >= 2) {
    return {
      space: 'social_good',
      reason: `The context for "${componentName}" strongly suggests a social good ` +
              `(signals: ${socialCtx.matched.join(', ')}). Consider whether this component ` +
              `participates in market dynamics before evaluating evolution.`,
      requiresReQuestion: true,
    };
  }

  // ── Common good detection ─────────────────────────────────────────────

  const commonName    = matchIndicators(name, COMMON_GOOD_INDICATORS);
  const commonCtx     = matchIndicators(ctx, COMMON_CONTEXT_SIGNALS);
  const commonCombined = matchIndicators(combined, COMMON_GOOD_INDICATORS);

  if (commonName.count > 0) {
    return {
      space: 'common_good',
      reason: `"${componentName}" is a common good (matched: ${commonName.matched.join(', ')}). ` +
              `Common goods have transcended market dynamics and cannot be placed on the standard evolution axis.`,
      requiresReQuestion: true,
    };
  }

  if (commonCombined.count > 0 && commonCtx.count > 0) {
    return {
      space: 'common_good',
      reason: `"${componentName}" in this context appears to be a common good ` +
              `(indicators: ${commonCombined.matched.join(', ')}; context signals: ${commonCtx.matched.join(', ')}). ` +
              `Common goods require re-framing before evolution evaluation.`,
      requiresReQuestion: true,
    };
  }

  if (commonCtx.count >= 2) {
    return {
      space: 'common_good',
      reason: `The context for "${componentName}" strongly suggests a common good ` +
              `(signals: ${commonCtx.matched.join(', ')}). Consider whether this component ` +
              `still participates in market dynamics.`,
      requiresReQuestion: true,
    };
  }

  // ── Default: economic space ───────────────────────────────────────────

  return {
    space: 'economic',
    reason: `"${componentName}" appears to be an economic component suitable for Wardley evolution evaluation.`,
    requiresReQuestion: false,
  };
}

/**
 * Build re-questioning prompts for non-economic components.
 * Returns an array of follow-up questions to present to the user.
 *
 * @param {ClassificationResult} classification
 * @param {string} componentName
 * @returns {string[]}
 */
export function buildReQuestions(classification, componentName) {
  if (!classification.requiresReQuestion) return [];

  if (classification.space === 'social_good') {
    return [
      `"${componentName}" appears to be a social good (naturally available, not market-produced). ` +
        `Did you mean a commodified or industrialized form of it?`,
      `For example, if you meant bottled oxygen or commercial air filtration, ` +
        `please re-specify the component with its economic context.`,
      `If you confirm this is a naturally available resource, it falls outside ` +
        `the Wardley evolution axis (evolution < 0, extra-competitive-market zone).`,
    ];
  }

  if (classification.space === 'common_good') {
    return [
      `"${componentName}" appears to be a common good (collectively managed, beyond market dynamics). ` +
        `Did you mean a privatized or market-available version of it?`,
      `If you confirm this is a collectively managed resource, it falls beyond ` +
        `the Wardley evolution axis (evolution > 1, extra-competitive-market zone).`,
    ];
  }

  return [];
}

// ─── Self-test ─────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const tests = [
    { name: 'Air', context: 'Athomospheric oxygen available to grow crops', expectedSpace: 'social_good' },
    { name: 'Oxygen', context: 'Hospital medical supply', expectedSpace: 'social_good' },
    { name: 'Sunlight', context: 'Solar energy for farming', expectedSpace: 'social_good' },
    { name: 'ERP', context: 'Big corporate', expectedSpace: 'economic' },
    { name: 'CRM', context: 'Enterprise software for sales teams', expectedSpace: 'economic' },
    { name: 'LLM', context: 'Automatic text generation for coding assistance', expectedSpace: 'economic' },
    { name: 'Wardley Mapping', context: 'Decision making framework for business strategy', expectedSpace: 'economic' },
    { name: 'Electricity', context: 'Western power supply today', expectedSpace: 'economic' },
    { name: 'Public Domain', context: 'Shared knowledge collectively managed', expectedSpace: 'common_good' },
  ];

  console.log('Classification gate self-test:\n');
  let passed = 0;
  for (const t of tests) {
    const result = classifyComponent(t.name, t.context);
    const ok = result.space === t.expectedSpace;
    const mark = ok ? '✓' : '✗';
    console.log(`  ${mark} ${t.name} (${t.context})`);
    console.log(`    Space: ${result.space} (expected: ${t.expectedSpace})`);
    console.log(`    Re-question: ${result.requiresReQuestion}`);
    console.log(`    Reason: ${result.reason}`);
    if (result.requiresReQuestion) {
      const questions = buildReQuestions(result, t.name);
      console.log(`    Follow-up questions:`);
      questions.forEach(q => console.log(`      → ${q}`));
    }
    console.log();
    if (ok) passed++;
  }
  console.log(`${passed}/${tests.length} tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
}
