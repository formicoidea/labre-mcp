// Timeline benchmark strategy: evolution estimation based on historical
// benchmarks and LLM-powered temporal reasoning.
//
// Tier 1: Curated reference components with known evolution positions
//         (fast, deterministic keyword matching)
// Tier 2: LLM historical reasoning — analyzes genesis/product/commodity
//         dates and current position (requires llmCall injection)
// Tier 3: Publication-type distribution model fallback
// Tier 4: Certitude/ubiquity rough midpoint fallback

import { BaseStrategy } from './base-strategy.mjs';
import { pubEvolution, PUB_TYPE_CENTROIDS } from '../s-curve.mjs';

// Historical benchmark components with known evolution positions
// Organized by Wardley evolution phase boundaries:
//   Genesis [0, 0.18] | Custom [0.18, 0.26] | Product [0.26, 0.70] | Commodity [0.70, 1.0]
const BENCHMARKS = [
  // Commodity (0.70–1.0)
  { keywords: ['electricity', 'power supply', 'power grid'],            evolution: 0.95, phase: 'commodity' },
  { keywords: ['water supply', 'running water', 'tap water'],           evolution: 0.95, phase: 'commodity' },
  { keywords: ['erp', 'enterprise resource planning'],                  evolution: 0.78, phase: 'commodity' },
  { keywords: ['crm', 'customer relationship management'],              evolution: 0.82, phase: 'commodity' },
  { keywords: ['email', 'smtp', 'electronic mail'],                     evolution: 0.92, phase: 'commodity' },
  { keywords: ['cloud computing', 'iaas', 'paas', 'cloud'],            evolution: 0.80, phase: 'commodity' },
  { keywords: ['database', 'rdbms', 'sql'],                             evolution: 0.85, phase: 'commodity' },
  { keywords: ['web server', 'http server'],                             evolution: 0.88, phase: 'commodity' },
  { keywords: ['operating system', 'os'],                                evolution: 0.90, phase: 'commodity' },
  { keywords: ['tcp/ip', 'internet protocol', 'networking'],            evolution: 0.92, phase: 'commodity' },
  { keywords: ['spreadsheet', 'excel'],                                  evolution: 0.88, phase: 'commodity' },

  // Product (0.26–0.70)
  { keywords: ['kubernetes', 'k8s', 'container orchestration'],         evolution: 0.62, phase: 'product' },
  { keywords: ['machine learning', 'ml'],                                evolution: 0.55, phase: 'product' },
  { keywords: ['devops', 'ci/cd', 'continuous integration'],            evolution: 0.58, phase: 'product' },
  { keywords: ['microservices', 'micro-services'],                       evolution: 0.52, phase: 'product' },
  { keywords: ['nosql', 'document database', 'mongodb'],                evolution: 0.55, phase: 'product' },
  { keywords: ['serverless', 'faas', 'lambda'],                         evolution: 0.48, phase: 'product' },

  // Custom (0.18–0.26)
  { keywords: ['llm', 'large language model', 'language model', 'gpt'], evolution: 0.80, phase: 'commodity' },
  { keywords: ['quantum computing', 'quantum computer'],                 evolution: 0.20, phase: 'custom' },
  { keywords: ['edge ai', 'edge computing ai'],                          evolution: 0.22, phase: 'custom' },

  // Genesis (0–0.18)
  { keywords: ['wardley mapping', 'wardley map'],                        evolution: 0.12, phase: 'genesis' },
  { keywords: ['agi', 'artificial general intelligence'],                evolution: 0.08, phase: 'genesis' },
  { keywords: ['brain-computer interface', 'bci', 'neural interface'],  evolution: 0.10, phase: 'genesis' },
  { keywords: ['fusion energy', 'nuclear fusion', 'fusion reactor'],    evolution: 0.14, phase: 'genesis' },

  // Extra-competitive (social/common goods)
  { keywords: ['air', 'atmospheric', 'oxygen', 'breathing'],            evolution: null, phase: 'extra-competitive' },
  { keywords: ['sunlight', 'solar radiation'],                           evolution: null, phase: 'extra-competitive' },
];

const TIMELINE_PROMPT = `You are an expert in technology history and Wardley Mapping.

Estimate the evolution position of a technology component based on its historical timeline.

Component: {{component}}
Context: {{context}}

REASONING STEPS:
1. When was this component first conceived or discovered? (genesis date)
2. When did it move from experimental/custom-built to having competing products? (product date)
3. When did it become standardized/commoditized, if ever? (commodity date)
4. How many years has elapsed in each phase?
5. What is the current state TODAY (${new Date().getFullYear()})?

Wardley evolution phases:
- Genesis [0, 0.18]: Novel, experimental, few understand it
- Custom [0.18, 0.26]: Emerging, being built for specific needs
- Product [0.26, 0.70]: Multiple competing implementations, well-understood
- Commodity [0.70, 1.0]: Standardized, utility, ubiquitous

Based on the timeline analysis, estimate the current evolution position.

MANDATORY FORMAT: exactly two lines at the end, no additional text after them:
evolution=X.XX
confidence=Y.YY`;

/**
 * Parse LLM timeline response into evolution and confidence values.
 * @param {string} text
 * @returns {{ evolution: number, confidence: number }}
 */
function parseTimelineResponse(text) {
  const evoMatch = text.match(/evolution[:\s=]*([\d.]+)/i);
  const confMatch = text.match(/confidence[:\s=]*([\d.]+)/i);

  if (!evoMatch) {
    throw new Error(`TimelineBenchmarkStrategy: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  return {
    evolution: parseFloat(evoMatch[1]),
    confidence: confMatch ? parseFloat(confMatch[1]) : 0.6,
  };
}

/**
 * Score how well a component matches a benchmark entry.
 * Returns 0 (no match) to 1 (perfect match).
 */
function matchScore(component, benchmark) {
  const searchText = `${component.name} ${component.context || ''} ${component.description || ''}`.toLowerCase();

  let bestScore = 0;
  for (const keyword of benchmark.keywords) {
    const kw = keyword.toLowerCase();
    if (searchText.includes(kw)) {
      // Longer keyword matches are more specific → higher score
      const score = kw.length / Math.max(searchText.length, 1);
      // Boost exact component name matches
      const nameMatch = component.name.toLowerCase().includes(kw) ||
                        kw.includes(component.name.toLowerCase());
      const boosted = nameMatch ? Math.min(1, score * 3 + 0.5) : score;
      bestScore = Math.max(bestScore, boosted);
    }
  }

  return bestScore;
}

export class TimelineBenchmarkStrategy extends BaseStrategy {

  /**
   * @param {Object} [options]
   * @param {function(string): Promise<string>} [options.llmCall]
   *   Optional async function for LLM-based historical reasoning.
   *   If not provided, only keyword matching and analytical fallbacks are used.
   */
  constructor({ llmCall } = {}) {
    super();
    this._llmCall = llmCall || null;
  }

  static get method() {
    return 'timeline-benchmark';
  }

  /**
   * @param {import('./base-strategy.mjs').ComponentInput} component
   * @returns {Promise<import('./base-strategy.mjs').EvolutionResult>}
   */
  async evaluate(component) {
    // Try benchmark matching first
    let bestMatch = null;
    let bestScore = 0;

    for (const benchmark of BENCHMARKS) {
      const score = matchScore(component, benchmark);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = benchmark;
      }
    }

    // If we have a strong benchmark match
    if (bestMatch && bestScore > 0.1) {
      // For extra-competitive goods (air, sunlight, etc.)
      if (bestMatch.evolution === null) {
        // Return a negative evolution to signal extra-competitive
        const result = {
          evolution: -0.5,
          confidence: Math.round(Math.min(0.9, bestScore + 0.3) * 1000) / 1000,
          method: TimelineBenchmarkStrategy.method,
        };
        return BaseStrategy.validateResult(result);
      }

      const result = {
        evolution: bestMatch.evolution,
        confidence: Math.round(Math.min(0.9, bestScore + 0.2) * 1000) / 1000,
        method: TimelineBenchmarkStrategy.method,
      };
      return BaseStrategy.validateResult(result);
    }

    // TIER 2: LLM historical reasoning
    if (this._llmCall) {
      const prompt = TIMELINE_PROMPT
        .replace('{{component}}', component.name || '')
        .replace('{{context}}', component.description || component.context || '');

      const response = await this._llmCall(prompt);
      const parsed = parseTimelineResponse(response);

      const result = {
        evolution: parsed.evolution,
        confidence: Math.min(0.85, parsed.confidence), // cap below benchmark confidence
        method: TimelineBenchmarkStrategy.method,
      };
      return BaseStrategy.validateResult(result);
    }

    // TIER 3: Publication type distribution fallback
    if (component.wonder != null && component.build != null &&
        component.operate != null && component.usage != null) {
      const evo = pubEvolution(component.wonder, component.build, component.operate, component.usage);
      if (evo !== null) {
        const result = {
          evolution: evo,
          confidence: 0.4, // Lower confidence for pub-distribution fallback
          method: TimelineBenchmarkStrategy.method,
        };
        return BaseStrategy.validateResult(result);
      }
    }

    // Last resort: if certitude/ubiquity available, rough midpoint estimate
    if (component.certitude != null && component.ubiquity != null) {
      const roughEvo = Math.round(((component.certitude + component.ubiquity) / 2) * 1000) / 1000;
      const result = {
        evolution: roughEvo,
        confidence: 0.2,
        method: TimelineBenchmarkStrategy.method,
      };
      return BaseStrategy.validateResult(result);
    }

    throw new Error('TimelineBenchmarkStrategy: insufficient data — need keywords, pub distribution, or certitude/ubiquity');
  }
}
