// Properties strategy: evaluates a named solution (e.g. Kubernetes, Salesforce,
// SAP ERP) against the 12-property Wardley evolution phase reference.
//
// The 12 properties are defined in evolution-properties.json and cover:
//   Market, Knowledge management, Market perception, User perception,
//   Perception in industry, Focus of value, Understanding, Comparison,
//   Failure, Market action, Efficiency, Decision drivers
//
// For each property the strategy determines which phase description (1–4)
// best matches the current state of the solution, then aggregates all
// property phases into a single evolution value using equal weights (1/12).
//
// This strategy supports two evaluation modes:
//   - Auto (oneshot):      LLM evaluates all 12 properties in a single call
//   - Conversational:      Properties can be evaluated incrementally
//
// Adding this file to src/strategies/solution/ is sufficient — the registry
// auto-discovers it via the *-strategy.mjs naming convention.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SolutionBaseStrategy } from './solution-base-strategy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Reference Data ────────────────────────────────────────────────────────

/** @type {object[]|null} Cached property reference from evolution-properties.json */
let _propertiesRef = null;

/**
 * Load the 12-property phase reference from evolution-properties.json.
 * Cached after first successful load.
 *
 * @returns {Promise<object[]>} Array of property definition objects
 */
async function loadPropertiesReference() {
  if (_propertiesRef) return _propertiesRef;

  const refPath = join(__dirname, 'evolution-properties.json');
  try {
    const raw = await readFile(refPath, 'utf-8');
    const data = JSON.parse(raw);
    const properties = data.properties || data;

    if (!Array.isArray(properties) || properties.length === 0) {
      throw new Error('evolution-properties.json must contain a non-empty array of properties');
    }

    _propertiesRef = properties;
    return _propertiesRef;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Fallback: use the embedded reference when JSON file is missing
      _propertiesRef = FALLBACK_PROPERTIES;
      return _propertiesRef;
    }
    throw err;
  }
}

/**
 * Clear properties reference cache. Useful for testing.
 */
export function clearPropertiesCache() {
  _propertiesRef = null;
}

// ─── Fallback Reference ────────────────────────────────────────────────────
// Embedded copy of the 12-property reference in case the JSON file is missing.
// Phase descriptions follow Wardley's evolution characteristics.

const FALLBACK_PROPERTIES = [
  {
    name: 'Market',
    phases: {
      '1': 'Undefined market; no established demand or supply dynamics exist yet',
      '2': 'Emerging market with early adopters exploring custom solutions and bespoke offerings',
      '3': 'Established market with growing competition, clear demand, and multiple recognized vendors',
      '4': 'Mature, commoditized market with stable demand, high volume, and price-driven competition',
    },
  },
  {
    name: 'Knowledge management',
    phases: {
      '1': 'Knowledge is scarce, tacit, and held by few experts or inventors; very little documented',
      '2': 'Knowledge is growing but fragmented across early practitioners; shared via informal communities',
      '3': 'Knowledge is widely published and taught; best practices, certifications, and formal training emerge',
      '4': 'Knowledge is ubiquitous, embedded in operations; considered baseline competency, extensively automated',
    },
  },
  {
    name: 'Market perception',
    phases: {
      '1': 'Poorly understood or unknown to the broader market; seen as experimental or unproven',
      '2': 'Recognized as a niche solution by early adopters; increasing awareness but limited mainstream trust',
      '3': 'Well-understood and accepted across the market; perceived as a proven, reliable solution category',
      '4': 'Taken for granted; invisible infrastructure that the market expects as a standard utility',
    },
  },
  {
    name: 'User perception',
    phases: {
      '1': 'Users see it as novel and experimental; willingness to tolerate imperfections for innovation',
      '2': 'Users perceive differentiation value; willing to invest in learning and customization',
      '3': 'Users expect feature completeness, reliability, and support; they compare alternatives systematically',
      '4': 'Users expect it to just work; seen as a commodity with minimal differentiation or switching cost',
    },
  },
  {
    name: 'Industry perception',
    phases: {
      '1': 'Industry views it as a research curiosity or science project; not yet taken seriously for production',
      '2': 'Industry acknowledges potential; early competitive advantages emerge for adopters',
      '3': 'Industry recognizes it as a strategic necessity; analysts track it, standards bodies engage',
      '4': 'Industry treats it as essential infrastructure; failure to adopt is a competitive disadvantage',
    },
  },
  {
    name: 'Value focus',
    phases: {
      '1': 'Value derived from novelty, exploration, and future potential; high risk tolerance',
      '2': 'Value derived from differentiation and competitive advantage through tailored solutions',
      '3': 'Value derived from reliability, feature richness, total cost of ownership, and ecosystem integration',
      '4': 'Value derived from cost efficiency, operational excellence, standardization, and scale economics',
    },
  },
  {
    name: 'Understanding',
    phases: {
      '1': 'Very poorly understood; the problem space is still being defined and explored',
      '2': 'Increasingly understood by specialists; solution patterns emerge but vary across implementations',
      '3': 'Well-understood with established architectures, reference models, and documented trade-offs',
      '4': 'Completely understood; commoditized knowledge embedded in standard operating procedures and automation',
    },
  },
  {
    name: 'Comparison',
    phases: {
      '1': 'No meaningful comparison possible; each implementation is unique and bespoke',
      '2': 'Comparison is possible but difficult; solutions differ significantly in approach and scope',
      '3': 'Feature-by-feature comparison is standard; industry benchmarks, analyst reports, and reviews available',
      '4': 'Comparison is trivial; solutions are interchangeable with focus on price, SLA, and availability',
    },
  },
  {
    name: 'Failure/deficiency',
    phases: {
      '1': 'High failure rates expected and tolerated; experimentation inherently involves failure',
      '2': 'Failures are common but decreasing; deficiencies are specific and addressed through iteration',
      '3': 'Failures are notable events; deficiencies are tracked via SLAs, bug databases, and quality metrics',
      '4': 'Failure is unacceptable and highly visible; deficiencies are rare and demand immediate remediation',
    },
  },
  {
    name: 'Market action/engagement',
    phases: {
      '1': 'Exploration and experimentation; building prototypes and proofs of concept with no established channels',
      '2': 'Early sales through direct engagement; custom contracts, consulting, and bespoke delivery',
      '3': 'Product marketing and competitive positioning; standardized sales channels, partnerships, and ecosystems',
      '4': 'Volume-based procurement; API-driven consumption, self-service portals, and utility pricing models',
    },
  },
  {
    name: 'Efficiency',
    phases: {
      '1': 'Very low efficiency; high resource investment per unit of output, significant waste in exploration',
      '2': 'Improving efficiency through learning; reducing waste as patterns and best practices emerge',
      '3': 'Good efficiency with established processes; measurable ROI, optimized delivery, and scaling operations',
      '4': 'Maximum efficiency through standardization, automation, and economies of scale; marginal cost approaches zero',
    },
  },
  {
    name: 'Decision driver',
    phases: {
      '1': 'Decisions driven by vision, intuition, and strategic bets on uncertain future value',
      '2': 'Decisions driven by competitive differentiation, first-mover advantage, and strategic fit',
      '3': 'Decisions driven by feature comparison, total cost of ownership, vendor stability, and risk mitigation',
      '4': 'Decisions driven by price, availability, compliance, and operational convenience',
    },
  },
];

// ─── LLM Prompt Templates ──────────────────────────────────────────────────

/**
 * Build the LLM prompt for evaluating all 12 properties at once (auto mode).
 *
 * @param {string} solutionName  - Name of the solution (e.g. "Kubernetes")
 * @param {string} context       - Business/usage context
 * @param {object[]} properties  - The 12-property reference
 * @returns {string} LLM prompt
 */
function buildAutoPrompt(solutionName, context, properties) {
  const propertyBlock = properties.map((prop, i) => {
    const phases = prop.phases || {};
    return [
      `${i + 1}. ${prop.name}`,
      `   Phase 1 (Genesis):   ${phases['1'] || 'N/A'}`,
      `   Phase 2 (Custom):    ${phases['2'] || 'N/A'}`,
      `   Phase 3 (Product):   ${phases['3'] || 'N/A'}`,
      `   Phase 4 (Commodity): ${phases['4'] || 'N/A'}`,
    ].join('\n');
  }).join('\n\n');

  return `You are a Wardley Mapping evolution expert.

Evaluate the solution "${solutionName}" against each of the 12 evolution properties below.
${context ? `Context: ${context}` : ''}

For each property, determine which phase (1–4) best describes the CURRENT state of "${solutionName}".

EVOLUTION PROPERTIES AND PHASE DESCRIPTIONS:
${propertyBlock}

INSTRUCTIONS:
- Evaluate "${solutionName}" as a SPECIFIC SOLUTION/PRODUCT, not the general capability it provides.
- Consider the current market state, not where it was years ago.
- For each property, choose the single phase (1, 2, 3, or 4) that best fits.
- Provide a brief reason (one sentence) for each evaluation.

MANDATORY OUTPUT FORMAT — exactly 12 lines, one per property:
${properties.map(p => `${p.name}=PHASE|reason`).join('\n')}

Where PHASE is 1, 2, 3, or 4 and reason is a brief explanation.
Example: Market=3|Growing competitive market with multiple established vendors`;
}

/**
 * Build a prompt for evaluating a single property (conversational mode).
 *
 * @param {string} solutionName  - Name of the solution
 * @param {string} context       - Business context
 * @param {object} property      - Single property definition
 * @returns {string} LLM prompt
 */
function buildSinglePropertyPrompt(solutionName, context, property) {
  const phases = property.phases || {};
  return `You are a Wardley Mapping evolution expert.

Evaluate the solution "${solutionName}" for the property: "${property.name}"
${context ? `Context: ${context}` : ''}

Phase descriptions for "${property.name}":
  Phase 1 (Genesis):   ${phases['1'] || 'N/A'}
  Phase 2 (Custom):    ${phases['2'] || 'N/A'}
  Phase 3 (Product):   ${phases['3'] || 'N/A'}
  Phase 4 (Commodity): ${phases['4'] || 'N/A'}

Which phase (1–4) best describes the current state of "${solutionName}" for this property?

MANDATORY FORMAT (last line, no text after):
${property.name}=PHASE|reason`;
}

// ─── Response Parsing ──────────────────────────────────────────────────────

/**
 * Parse the LLM response from auto mode (all 12 properties evaluated at once).
 *
 * Expected format per line: PropertyName=PHASE|reason
 *
 * @param {string} text        - Raw LLM response
 * @param {object[]} properties - Property reference for name matching
 * @returns {Array<{property: string, phase: number, reason: string}>}
 */
export function parseAutoResponse(text, properties) {
  const results = [];
  const propertyNames = properties.map(p => p.name.toLowerCase());

  // Match lines like: PropertyName=3|Some reason here
  // Also handle variations: PropertyName = 3 | reason
  const linePattern = /^(.+?)\s*=\s*(\d)\s*\|\s*(.+)$/;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(linePattern);
    if (!match) continue;

    const [, rawName, phaseStr, reason] = match;
    const phase = parseInt(phaseStr, 10);
    if (phase < 1 || phase > 4) continue;

    // Fuzzy match property name to reference
    const matchedName = fuzzyMatchProperty(rawName.trim(), properties);
    if (matchedName) {
      results.push({
        property: matchedName,
        phase,
        reason: reason.trim(),
      });
    }
  }

  return results;
}

/**
 * Parse a single-property evaluation response.
 *
 * @param {string} text     - Raw LLM response
 * @param {object} property - Property definition for name matching
 * @returns {{ property: string, phase: number, reason: string }|null}
 */
export function parseSinglePropertyResponse(text, property) {
  const linePattern = /^(.+?)\s*=\s*(\d)\s*\|\s*(.+)$/;

  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(linePattern);
    if (!match) continue;

    const [, , phaseStr, reason] = match;
    const phase = parseInt(phaseStr, 10);
    if (phase >= 1 && phase <= 4) {
      return {
        property: property.name,
        phase,
        reason: reason.trim(),
      };
    }
  }

  // Fallback: try to find just a number 1-4
  const numMatch = text.match(/(?:phase|=)\s*(\d)/i);
  if (numMatch) {
    const phase = parseInt(numMatch[1], 10);
    if (phase >= 1 && phase <= 4) {
      return {
        property: property.name,
        phase,
        reason: 'Extracted from partial response',
      };
    }
  }

  return null;
}

/**
 * Fuzzy match an LLM-returned property name to the reference list.
 * Uses case-insensitive substring matching.
 *
 * @param {string} rawName     - Name from LLM output
 * @param {object[]} properties - Reference property list
 * @returns {string|null} Matched property name or null
 */
function fuzzyMatchProperty(rawName, properties) {
  const lower = rawName.toLowerCase().trim();

  // Exact match (case-insensitive)
  for (const prop of properties) {
    if (prop.name.toLowerCase() === lower) return prop.name;
  }

  // Substring match: reference name contained in rawName
  for (const prop of properties) {
    const refLower = prop.name.toLowerCase();
    if (lower.includes(refLower) || refLower.includes(lower)) {
      return prop.name;
    }
  }

  // Word-based match: majority of words in common
  const rawWords = new Set(lower.split(/\s+/));
  let bestMatch = null;
  let bestOverlap = 0;
  for (const prop of properties) {
    const refWords = prop.name.toLowerCase().split(/\s+/);
    const overlap = refWords.filter(w => rawWords.has(w)).length;
    if (overlap > bestOverlap && overlap >= Math.ceil(refWords.length / 2)) {
      bestOverlap = overlap;
      bestMatch = prop.name;
    }
  }

  return bestMatch;
}

// ─── PropertiesStrategy ────────────────────────────────────────────────────

/**
 * Evaluates a named solution against the 12-property Wardley evolution
 * phase reference, producing a weighted aggregation of per-property
 * phase evaluations.
 *
 * @example
 *   const strategy = new PropertiesStrategy({ llmCall: myLlmFn });
 *   const result = await strategy.evaluate({ name: 'Kubernetes' });
 *   // → { evolution: 0.62, confidence: 0.85, method: 'solution-properties', properties: [...] }
 */
export class PropertiesStrategy extends SolutionBaseStrategy {
  _llmCall: any;
  _mode: any;

  constructor({ llmCall, mode = 'auto' }: any = {}) {
    super();
    if (typeof llmCall !== 'function') {
      throw new Error('PropertiesStrategy requires an llmCall function');
    }
    this._llmCall = llmCall;
    this._mode = mode;
  }

  static get method() {
    return 'solution-properties';
  }

  /**
   * Evaluate a solution component against all 12 properties.
   *
   * In auto mode: single LLM call evaluating all properties at once.
   * In conversational mode: one LLM call per property (slower but interactive).
   *
   * @param {import('./solution-base-strategy.mjs').SolutionInput} component
   * @returns {Promise<import('./solution-base-strategy.mjs').SolutionEvolutionResult>}
   */
  async evaluate(component) {
    const properties = await loadPropertiesReference();
    const solutionName = component.name || 'Unknown Solution';

    // Compose context from all available sources.
    // In conversational mode, the session enriches component.context with
    // solutionContext, marketDynamics, and adoptionPattern. We also explicitly
    // check component.solutionContext to handle cases where context was not
    // pre-composed (e.g. direct strategy invocation).
    const contextParts = [];
    if (component.context) contextParts.push(component.context);
    else if (component.description) contextParts.push(component.description);
    if (component.solutionContext && !contextParts.some(p => p.includes(component.solutionContext))) {
      contextParts.push(component.solutionContext);
    }
    // Pull in metadata fields if not already in context
    if (component.metadata) {
      if (component.metadata.marketDynamics && !contextParts.some(p => p.includes(component.metadata.marketDynamics))) {
        contextParts.push(`Market dynamics: ${component.metadata.marketDynamics}`);
      }
      if (component.metadata.adoptionPattern && !contextParts.some(p => p.includes(component.metadata.adoptionPattern))) {
        contextParts.push(`Adoption pattern: ${component.metadata.adoptionPattern}`);
      }
    }
    const context = contextParts.join('. ') || '';

    let propertyEvaluations;

    if (this._mode === 'conversational') {
      propertyEvaluations = await this._evaluateConversational(
        solutionName, context, properties
      );
    } else {
      propertyEvaluations = await this._evaluateAuto(
        solutionName, context, properties
      );
    }

    // Build PropertyEvaluation entries
    const propResults = propertyEvaluations.map(pe =>
      SolutionBaseStrategy.buildPropertyEvaluation(pe.property, pe.phase, pe.reason)
    );

    // Fill in any missing properties with a fallback (phase 2.5 ≈ midpoint)
    const evaluatedNames = new Set(propResults.map(p => p.property));
    for (const prop of properties) {
      if (!evaluatedNames.has(prop.name)) {
        propResults.push(
          SolutionBaseStrategy.buildPropertyEvaluation(
            prop.name,
            2, // Default to Custom (phase 2) for unevaluated properties
            'Not evaluated — defaulted to Custom (phase 2)'
          )
        );
      }
    }

    // Aggregate into single evolution value
    const { evolution, confidence } = SolutionBaseStrategy.aggregateProperties(propResults);

    // Adjust confidence based on how many properties were actually evaluated by LLM
    const evaluatedRatio = propertyEvaluations.length / properties.length;
    const adjustedConfidence = Math.round(
      confidence * (0.5 + 0.5 * evaluatedRatio) * 1000
    ) / 1000;

    const result = {
      evolution,
      confidence: Math.min(adjustedConfidence, 0.95),
      method: PropertiesStrategy.method,
      properties: propResults,
      trace: [
        { step: 'load-reference', propertyCount: properties.length },
        { step: 'evaluate-properties', mode: this._mode, evaluated: propertyEvaluations.length, total: properties.length },
        ...propertyEvaluations.map(pe => ({
          step: 'property-result',
          property: pe.property,
          phase: pe.phase,
          reason: pe.reason,
        })),
      ],
    };

    return SolutionBaseStrategy.validateSolutionResult(result);
  }

  /**
   * Evaluate all 12 properties in a single LLM call (auto/oneshot mode).
   *
   * @param {string} solutionName
   * @param {string} context
   * @param {object[]} properties
   * @returns {Promise<Array<{property: string, phase: number, reason: string}>>}
   * @private
   */
  async _evaluateAuto(solutionName, context, properties) {
    const prompt = buildAutoPrompt(solutionName, context, properties);
    const response = await this._llmCall(prompt);
    return parseAutoResponse(response, properties);
  }

  /**
   * Evaluate properties one at a time (conversational mode).
   *
   * @param {string} solutionName
   * @param {string} context
   * @param {object[]} properties
   * @returns {Promise<Array<{property: string, phase: number, reason: string}>>}
   * @private
   */
  async _evaluateConversational(solutionName, context, properties) {
    const results = [];

    for (const prop of properties) {
      const prompt = buildSinglePropertyPrompt(solutionName, context, prop);
      const response = await this._llmCall(prompt);
      const parsed = parseSinglePropertyResponse(response, prop);

      if (parsed) {
        results.push(parsed);
      }
    }

    return results;
  }

  /**
   * Evaluate a single property (for external conversational orchestration).
   * This allows an orchestrator to call property-by-property evaluation
   * from outside the strategy.
   *
   * @param {string} solutionName   - Solution name
   * @param {string} context        - Business context
   * @param {string} propertyName   - Name of the property to evaluate
   * @returns {Promise<import('./solution-base-strategy.mjs').PropertyEvaluation|null>}
   */
  async evaluateSingleProperty(solutionName, context, propertyName) {
    const properties = await loadPropertiesReference();
    const prop = properties.find(
      p => p.name.toLowerCase() === propertyName.toLowerCase()
    );

    if (!prop) {
      const available = properties.map(p => p.name).join(', ');
      throw new Error(
        `Unknown property "${propertyName}". Available: ${available}`
      );
    }

    const prompt = buildSinglePropertyPrompt(solutionName, context, prop);
    const response = await this._llmCall(prompt);
    const parsed = parseSinglePropertyResponse(response, prop);

    if (!parsed) return null;

    return SolutionBaseStrategy.buildPropertyEvaluation(
      parsed.property,
      parsed.phase,
      parsed.reason
    );
  }

  /**
   * Get the list of property names from the reference.
   * Useful for conversational orchestration to know which properties to ask about.
   *
   * @returns {Promise<string[]>}
   */
  async getPropertyNames() {
    const properties = await loadPropertiesReference();
    return properties.map(p => p.name);
  }
}
