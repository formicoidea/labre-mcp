// Publication analysis strategy: estimates evolution from the distribution
// of publication types (wonder / build / operate / usage) for a component.
//
// This is an analytical (non-LLM) strategy when publication proportions are
// provided directly. When an LLM call function is injected, it can also
// estimate publication proportions from a component name and context.
//
// The strategy:
//   1. Uses publication type proportions (wonder, build, operate, usage)
//   2. Computes evolution as a weighted centroid using phase midpoints
//   3. Derives confidence from the concentration of the distribution
//      (peaked distribution = high confidence, uniform = low confidence)
//   4. Optionally falls back to LLM-estimated proportions if none provided

import { BaseStrategy } from './base-strategy.mjs';
import { pubEvolution, PUB_TYPE_CENTROIDS } from '../../s-curve/s-curve.mjs';

// --- Advanced publication-based evolution model ---
// The simple centroid model (pubEvolution) maps dominant publication types to their
// phase midpoints, which works well for usage-dominant components but fails for
// build-dominant ones (e.g., LLM) that are actually in the commodity phase.
//
// This advanced model uses a sigmoid of the later-phase publication ratio,
// penalized by wonder dominance. Key insight: the PRESENCE of operate/usage
// publications is a stronger evolution signal than the dominant type.
const PUB_SIGMOID_K = 8;      // steepness
const PUB_SIGMOID_X0 = 0.30;  // center — laterRatio ≥ 0.42 maps to evo ≥ 0.7

/**
 * Advanced publication-phase evolution model.
 * Uses a sigmoid of the later-phase (operate + usage) publication ratio,
 * penalized by wonder dominance.
 *
 * @param {number} wonder  - Wonder proportion
 * @param {number} build   - Build proportion
 * @param {number} operate - Operate proportion
 * @param {number} usage   - Usage proportion
 * @returns {number|null} Evolution in [0, 1] or null if all zeros
 */
export function advancedPubEvolution(wonder: number, build: number, operate: number, usage: number): any {
  const sum = wonder + build + operate + usage;
  if (sum === 0) return null;

  const w = wonder / sum;
  const laterRatio = (operate + usage) / sum;

  // Sigmoid of later-phase publication ratio
  const rawEvolution = 1 / (1 + Math.exp(-PUB_SIGMOID_K * (laterRatio - PUB_SIGMOID_X0)));

  // Penalty for high wonder proportion (genesis indicator)
  const wonderPenalty = Math.pow(1 - w, 0.5);

  return Math.round(rawEvolution * wonderPenalty * 1000) / 1000;
}

const PUB_PROMPT_TEMPLATE = `You are an expert bibliometrician and technology analyst.

Your task is to estimate the publication type distribution for a technology component.
DO NOT guess — reason step by step from what you know about the actual publication landscape.

Component: {{component}}
Context: {{context}}

REASONING STEPS:
1. What major publication venues cover this component? (journals, conferences, blogs, Stack Overflow, vendor docs, GitHub repos)
2. What is the approximate volume and recency of publications?
3. Classify the publication landscape into four types:
   - wonder: Research papers about novel applications, discovery, "look what's possible" articles, breakthrough announcements
   - build: Tutorials, "how to build", architectural guides, comparison articles, getting-started guides
   - operate: Operations manuals, SRE guides, monitoring/scaling articles, migration guides, troubleshooting, best practices
   - usage: Commodity usage documentation, API references, pricing comparisons, "just use it" guides, vendor documentation
4. Consider temporal dynamics: older components have more operate/usage; newer ones have more wonder/build
5. Consider the ratio between academic vs. practitioner publications
6. Consider whether the component has an active open-source ecosystem (more build) or is primarily commercial (more usage/operate)

Based on your analysis, provide the proportion of each publication type.
The four proportions MUST sum to approximately 1.0.

MANDATORY FORMAT: exactly four lines at the end, no additional text after them:
wonder=W.WW
build=B.BB
operate=O.OO
usage=U.UU`;

/**
 * Parse LLM response into publication proportions.
 * @param {string} text
 * @returns {{ wonder: number, build: number, operate: number, usage: number }}
 */
function parsePubResponse(text: string): any {
  // Anchor on the "MANDATORY FORMAT" contract from the prompt: one `key=value`
  // per line. This avoids matching the keywords when they appear in multilingual
  // prose above the final block (which caused NaN on e.g. "wonder." sentence ends).
  const NUM = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
  const lineFor = (key: string) => new RegExp(`^\\s*${key}\\s*[:=]\\s*${NUM}\\s*$`, 'im');
  const wMatch = text.match(lineFor('wonder'));
  const bMatch = text.match(lineFor('build'));
  const oMatch = text.match(lineFor('operate'));
  const uMatch = text.match(lineFor('usage'));

  if (!wMatch || !bMatch || !oMatch || !uMatch) {
    throw new Error(`PublicationAnalysisStrategy: could not parse response: ${text.slice(0, 200)}`);
  }

  const vals = {
    wonder:  parseFloat(wMatch[1]),
    build:   parseFloat(bMatch[1]),
    operate: parseFloat(oMatch[1]),
    usage:   parseFloat(uMatch[1]),
  };
  const raw = { wonder: wMatch[1], build: bMatch[1], operate: oMatch[1], usage: uMatch[1] };
  for (const [k, v] of Object.entries(vals)) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(
        `PublicationAnalysisStrategy: invalid ${k} value "${(raw as any)[k]}" parsed from LLM response`
      );
    }
  }
  return vals;
}

/**
 * Compute concentration score: how peaked the distribution is.
 * Uses the Herfindahl-Hirschman Index (sum of squared proportions).
 * Uniform = 0.25 (min), single dominant = 1.0 (max).
 * Normalized to [0, 1] for confidence.
 *
 * @param {number} w - wonder proportion (normalized)
 * @param {number} b - build proportion (normalized)
 * @param {number} o - operate proportion (normalized)
 * @param {number} u - usage proportion (normalized)
 * @returns {number} Concentration in [0, 1]
 */
function concentration(w: number, b: number, o: number, u: number): number {
  const hhi = w * w + b * b + o * o + u * u;
  // HHI ranges from 0.25 (uniform) to 1.0 (single dominant)
  // Normalize to [0, 1]
  return (hhi - 0.25) / 0.75;
}

export class PublicationAnalysisStrategy extends BaseStrategy {
  _llmCall: any;

  constructor({ llmCall }: any = {}) {
    super();
    this._llmCall = llmCall || null;
  }

  static get method() {
    return 'publication-analysis';
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult>|import('./base-strategy.mjs').EvolutionResult}
   */
  async evaluate(component: any): Promise<any> {
    let wonder, build, operate, usage;

    // Use provided publication proportions if available
    if (component.wonder != null && component.build != null &&
        component.operate != null && component.usage != null) {
      wonder = component.wonder;
      build = component.build;
      operate = component.operate;
      usage = component.usage;
    } else if (this._llmCall) {
      // Fall back to LLM estimation
      const prompt = PUB_PROMPT_TEMPLATE
        .replace('{{component}}', component.name || '')
        .replace('{{context}}', component.description || component.context || '');

      const response = await this._llmCall(prompt);
      const parsed = parsePubResponse(response);
      wonder = parsed.wonder;
      build = parsed.build;
      operate = parsed.operate;
      usage = parsed.usage;
    } else {
      throw new Error(
        'PublicationAnalysisStrategy: requires publication proportions (wonder, build, operate, usage) ' +
        'on the component, or an llmCall function for estimation'
      );
    }

    // Normalize proportions
    const sum = wonder + build + operate + usage;
    if (sum === 0) {
      throw new Error('PublicationAnalysisStrategy: all publication proportions are zero');
    }

    const nw = wonder / sum;
    const nb = build / sum;
    const no = operate / sum;
    const nu = usage / sum;

    // Compute evolution as weighted centroid
    const evolution = pubEvolution(wonder, build, operate, usage);

    if (evolution === null || !Number.isFinite(evolution)) {
      throw new Error('PublicationAnalysisStrategy: pubEvolution returned invalid value');
    }

    // Confidence from distribution concentration
    const conc = concentration(nw, nb, no, nu);
    const confidence = Math.round(Math.max(0.2, Math.min(0.95, 0.3 + conc * 0.65)) * 1000) / 1000;

    const result = {
      evolution,
      confidence,
      method: PublicationAnalysisStrategy.method,
    };

    return BaseStrategy.validateResult(result);
  }
}

// Export internals for testing
export { parsePubResponse, concentration };
