// Conversational guided interaction session for evolution estimation
//
// Manages multi-turn state for progressively gathering component information
// before producing a final evolution estimation. The session accumulates
// context across exchanges and determines when enough data has been gathered.
//
// Question phases (capability path):
//   1. Identity       — component name and description (required)
//   2. Classification — economic space pre-check + solution vs capability detection
//   3. Characteristics — certitude, ubiquity, maturity indicators
//   4. Market signals — publication types, market dynamics, adoption patterns
//   5. Final — estimation with accumulated context
//
// Question phases (solution path):
//   1. Identity       — component name and description (required)
//   2. Classification — economic space pre-check + solution vs capability detection
//   3. Solution context — market position, adoption, maturity for 12-property evaluation
//   4. Final — estimation with accumulated context
//
// After the classification phase, the session detects whether the component
// is a concrete named solution (e.g. "Kubernetes", "Salesforce") or an
// abstract capability (e.g. "container orchestration", "CRM"). Solutions
// branch to a solution-specific path evaluated against 12 Wardley evolution
// properties; capabilities continue through the existing characteristics/
// market-signals path.
//
// Usage:
//   const session = new ConversationSession();
//   session.update({ name: 'ERP', description: '...' });
//   const next = session.nextQuestion();
//   // ... exchange more turns ...
//   if (session.isReadyForEstimation()) { ... }

import { classifyComponent, buildReQuestions } from '../work-on-evolution/routing/classification-gate.mjs';
import {
  detectComponentType,
  COMPONENT_TYPE,
  CONFIDENCE_THRESHOLD,
} from '../lib/component-detection.mjs';

// ─── Question Phases ────────────────────────────────────────────────────────

/**
 * @typedef {'identity' | 'classification' | 'characteristics' | 'market_signals' | 'solution_context' | 'ready'} Phase
 */

/**
 * @typedef {Object} QuestionSet
 * @property {Phase}    phase    - Current conversation phase
 * @property {string}   prompt   - Main question/prompt to present to the user
 * @property {string[]} hints    - Follow-up hints or sub-questions
 * @property {string[]} fields   - Data fields this question phase aims to gather
 */

/**
 * @typedef {Object} SessionState
 * @property {string|null}  name        - Component name
 * @property {string|null}  description - Business/usage context
 * @property {string|null}  space       - Classified economic space
 * @property {number|null}  certitude   - How well-understood (0–1)
 * @property {number|null}  ubiquity    - How widespread (0–1)
 * @property {number|null}  wonder      - Publication proportion: novelty
 * @property {number|null}  build       - Publication proportion: building
 * @property {number|null}  operate     - Publication proportion: operations
 * @property {number|null}  usage       - Publication proportion: commodity
 * @property {string|null}  sector      - Industry sector
 * @property {string|null}  maturitySignals - Free-text maturity observations
 * @property {string|null}  marketDynamics  - Free-text market dynamics observations
 * @property {string|null}  adoptionPattern - Adoption pattern description
 * @property {string|null}  strategy    - Preferred strategy (or 'all')
 * @property {string|null}  componentType   - Detected type: 'solution' or 'capability'
 * @property {number|null}  componentTypeConfidence - Detection confidence (0–1)
 * @property {string|null}  componentTypeMethod     - Detection method (e.g. 'known-solution', 'heuristic')
 * @property {string|null}  solutionContext - Free-text context for solution 12-property evaluation
 * @property {Phase}        phase       - Current conversation phase
 * @property {string[]}     history     - Log of gathered fields per exchange
 */

// ─── Phase Question Templates ───────────────────────────────────────────────

const PHASE_QUESTIONS = {
  identity: {
    phase: 'identity',
    prompt: 'What component would you like to evaluate? Please provide its name and a brief description of what it does and its business context.',
    hints: [
      'Example: "ERP — Enterprise resource planning software used by large corporations for finance and HR"',
      'The more context you provide, the more accurate the estimation will be.',
      'Include the industry sector if relevant (e.g., healthcare, fintech, manufacturing).',
    ],
    fields: ['name', 'description'],
  },

  classification: {
    phase: 'classification',
    prompt: 'Based on what you described, I need to understand the economic nature of this component.',
    hints: [
      'Is this component traded in markets, or is it a naturally available resource (like air, sunlight)?',
      'Is it collectively managed as a public good (like public infrastructure, open standards)?',
      'Or does it participate in standard market dynamics with suppliers, competitors, and pricing?',
    ],
    fields: ['space'],
  },

  characteristics: {
    phase: 'characteristics',
    prompt: 'Let me understand the maturity characteristics of this component.',
    hints: [
      '**Certitude** (0–1): How well-understood and defined is this component? (0 = novel/experimental, 1 = fully standardized and documented)',
      '**Ubiquity** (0–1): How widespread is adoption? (0 = rare/niche, 1 = universally used)',
      'Think about: Is there a dominant design? Are there established best practices? How many competing implementations exist?',
      'Consider: Can you hire specialists easily? Are there certifications? Is the supply chain mature?',
    ],
    fields: ['certitude', 'ubiquity'],
  },

  market_signals: {
    phase: 'market_signals',
    prompt: 'Now let me gather market and publication signals to refine the estimation.',
    hints: [
      '**Publication types** — What kind of content dominates for this component?',
      '  • Wonder (0–1): Research papers, "look at this amazing thing" blog posts, conference talks about possibilities',
      '  • Build (0–1): Tutorials, "how to build X", learning resources, experimentation guides',
      '  • Operate (0–1): Operations guides, feature comparisons, "how to run X in production"',
      '  • Usage (0–1): Commodity usage docs, "just use it" references, pricing comparisons',
      '(These four should sum to approximately 1.0)',
      '',
      '**Market dynamics**: Are there many competitors? Is pricing converging? Are there utility providers?',
      '**Adoption pattern**: Is adoption accelerating, plateauing, or ubiquitous?',
    ],
    fields: ['wonder', 'build', 'operate', 'usage', 'maturitySignals', 'marketDynamics', 'adoptionPattern'],
  },
};

// ─── Solution-Specific Phase Questions ──────────────────────────────────────
//
// When a component is detected as a concrete named solution (e.g. Kubernetes,
// Salesforce), the conversation branches to solution-specific questions that
// gather context for the 12-property evolution evaluation. These questions map
// to the Wardley evolution properties: Market, Knowledge, Perception, Value
// focus, Understanding, Comparison, Efficiency, etc.

const SOLUTION_PHASE_QUESTIONS = {
  solution_context: {
    phase: 'solution_context',
    prompt: 'I\'ve identified this as a specific named solution/product. Let me gather context for the 12-property Wardley evolution evaluation.',
    hints: [
      '**Market & Competition**: How many competitors/alternatives exist? Is pricing converging? Are there utility providers?',
      '**Adoption & Knowledge**: How widely adopted is this solution? Is there formal training, certifications? Are specialists easy to hire?',
      '**Perception**: How is it perceived by users and the industry? Is it taken for granted, or seen as novel/differentiating?',
      '**Maturity**: How long has it been available? Is it well-documented with established best practices?',
      '**Value & Efficiency**: What drives adoption decisions — innovation, differentiation, features, or cost/availability?',
      'Any additional context about vendor, ecosystem, or market position will improve the evaluation.',
    ],
    fields: ['solutionContext', 'marketDynamics', 'adoptionPattern'],
  },
};

// ─── Maturity Indicator Inference ───────────────────────────────────────────

/**
 * Infer certitude/ubiquity from free-text maturity signals.
 * Returns partial values that can supplement explicit user-provided values.
 *
 * @param {string} text - Free-text description of maturity signals
 * @returns {{ certitude?: number, ubiquity?: number }}
 */
export function inferFromMaturitySignals(text: string): any {
  if (!text) return {};
  const t = text.toLowerCase();
  const inferred: any = {};

  // Certitude signals
  const highCertitude = [
    'well understood', 'standardized', 'well-defined', 'documented',
    'best practices', 'established', 'mature', 'proven', 'reliable',
    'industry standard', 'commodity', 'utility', 'dominant design',
  ];
  const lowCertitude = [
    'experimental', 'novel', 'emerging', 'uncertain', 'unproven',
    'cutting edge', 'cutting-edge', 'research', 'prototype', 'beta',
    'early stage', 'early-stage', 'poc', 'proof of concept',
  ];

  const highCertCount = highCertitude.filter(s => t.includes(s)).length;
  const lowCertCount = lowCertitude.filter(s => t.includes(s)).length;
  if (highCertCount > 0 || lowCertCount > 0) {
    const total = highCertCount + lowCertCount;
    inferred.certitude = Math.round((highCertCount / total) * 100) / 100;
  }

  // Ubiquity signals
  const highUbiquity = [
    'widespread', 'ubiquitous', 'universal', 'everywhere', 'common',
    'mainstream', 'mass market', 'mass adoption', 'widely adopted',
    'standard', 'default choice', 'commodity', 'utility',
  ];
  const lowUbiquity = [
    'rare', 'niche', 'specialized', 'few users', 'limited adoption',
    'early adopters', 'early-adopter', 'small market', 'exclusive',
    'custom built', 'custom-built', 'bespoke',
  ];

  const highUbiCount = highUbiquity.filter(s => t.includes(s)).length;
  const lowUbiCount = lowUbiquity.filter(s => t.includes(s)).length;
  if (highUbiCount > 0 || lowUbiCount > 0) {
    const total = highUbiCount + lowUbiCount;
    inferred.ubiquity = Math.round((highUbiCount / total) * 100) / 100;
  }

  return inferred;
}

/**
 * Infer publication proportions from market dynamics text.
 *
 * @param {string} marketDynamics - Free-text market dynamics description
 * @param {string} adoptionPattern - Free-text adoption pattern description
 * @returns {{ wonder?: number, build?: number, operate?: number, usage?: number }}
 */
export function inferFromMarketSignals(marketDynamics, adoptionPattern) {
  const text = `${marketDynamics || ''} ${adoptionPattern || ''}`.toLowerCase();
  if (!text.trim()) return {};

  // Market signal patterns
  const commoditySignals = [
    'utility', 'commodity', 'many competitors', 'pricing converging',
    'price war', 'standardized', 'interchangeable', 'api-first',
    'pay per use', 'pay-per-use', 'metered', 'ubiquitous',
  ];
  const productSignals = [
    'few competitors', 'dominant players', 'feature differentiation',
    'product comparison', 'market leader', 'market share',
    'enterprise sales', 'vendor lock-in',
  ];
  const customSignals = [
    'custom development', 'bespoke', 'consulting', 'integration work',
    'system integrator', 'professional services', 'custom built',
  ];
  const genesisSignals = [
    'no competitors', 'first mover', 'research phase', 'experimental',
    'proof of concept', 'venture capital', 'startup', 'seed funding',
  ];

  const scores = {
    genesis: genesisSignals.filter(s => text.includes(s)).length,
    custom: customSignals.filter(s => text.includes(s)).length,
    product: productSignals.filter(s => text.includes(s)).length,
    commodity: commoditySignals.filter(s => text.includes(s)).length,
  };

  const total = scores.genesis + scores.custom + scores.product + scores.commodity;
  if (total === 0) return {};

  return {
    wonder: Math.round((scores.genesis / total) * 100) / 100,
    build: Math.round((scores.custom / total) * 100) / 100,
    operate: Math.round((scores.product / total) * 100) / 100,
    usage: Math.round((scores.commodity / total) * 100) / 100,
  };
}

// ─── ConversationSession class ──────────────────────────────────────────────

/**
 * Manages multi-turn conversational state for evolution estimation.
 * Progressively gathers component information and determines when
 * enough context has been accumulated to produce an estimation.
 */
export class ConversationSession {
  state: any;
  exchanges: any;

  constructor(initial: any = {}) {
    /** @type {SessionState} */
    this.state = {
      name: null,
      description: null,
      space: null,
      certitude: null,
      ubiquity: null,
      wonder: null,
      build: null,
      operate: null,
      usage: null,
      sector: null,
      maturitySignals: null,
      marketDynamics: null,
      adoptionPattern: null,
      strategy: 'all',
      componentType: null,
      componentTypeConfidence: null,
      componentTypeMethod: null,
      solutionContext: null,
      phase: 'identity',
      history: [],
      ...initial,
    };

    // If initial data provided, advance phase
    if (this.state.name) {
      this._advancePhase();
    }
  }

  /**
   * Update session state with new information from a user exchange.
   * Automatically advances the phase when sufficient data is gathered.
   *
   * @param {Object} data - Key-value pairs to merge into the state
   * @returns {ConversationSession} this (for chaining)
   */
  update(data) {
    const gathered = [];

    for (const [key, value] of Object.entries(data)) {
      if (value != null && value !== '' && key in this.state && key !== 'phase' && key !== 'history') {
        this.state[key] = value;
        gathered.push(key);
      }
    }

    if (gathered.length > 0) {
      this.state.history.push(`Exchange ${this.state.history.length + 1}: gathered ${gathered.join(', ')}`);
    }

    // Attempt to infer additional data from free-text fields
    this._inferFromContext();

    // Advance phase if current phase is satisfied
    this._advancePhase();

    return this;
  }

  /**
   * Get the current conversation phase.
   * @returns {Phase}
   */
  get phase() {
    return this.state.phase;
  }

  /**
   * Get the next set of questions for the current phase.
   * Returns null if the session is ready for estimation.
   *
   * @returns {QuestionSet | null}
   */
  nextQuestion() {
    if (this.state.phase === 'ready') {
      return null;
    }

    // Look up in standard phases first, then solution-specific phases
    const template = PHASE_QUESTIONS[this.state.phase] || SOLUTION_PHASE_QUESTIONS[this.state.phase];
    if (!template) return null;

    // Customize hints based on already-gathered data
    const customized = { ...template, hints: [...template.hints] };

    if (this.state.phase === 'characteristics') {
      if (this.state.certitude != null) {
        customized.hints.unshift(`✓ Certitude already provided: ${this.state.certitude}`);
      }
      if (this.state.ubiquity != null) {
        customized.hints.unshift(`✓ Ubiquity already provided: ${this.state.ubiquity}`);
      }
    }

    if (this.state.phase === 'market_signals') {
      const hasPubs = this.state.wonder != null && this.state.build != null &&
                      this.state.operate != null && this.state.usage != null;
      if (hasPubs) {
        customized.hints.unshift(
          `✓ Publication proportions already provided: ` +
          `wonder=${this.state.wonder}, build=${this.state.build}, ` +
          `operate=${this.state.operate}, usage=${this.state.usage}`
        );
      }
    }

    // Solution-specific phase: add component type detection info
    if (this.state.phase === 'solution_context') {
      const typeInfo = this.state.componentType === COMPONENT_TYPE.SOLUTION
        ? `✓ Detected as solution (confidence: ${(this.state.componentTypeConfidence * 100).toFixed(0)}%, method: ${this.state.componentTypeMethod})`
        : `✓ Component type: ${this.state.componentType}`;
      customized.hints.unshift(typeInfo);

      if (this.state.solutionContext) {
        customized.hints.unshift(`✓ Solution context already provided`);
      }
    }

    return customized;
  }

  /**
   * Check if enough context has been accumulated for an estimation.
   * Minimum requirement: name + at least one of (certitude/ubiquity, publication proportions,
   * or enough free-text signals for inference).
   *
   * @returns {boolean}
   */
  isReadyForEstimation() {
    return this.state.phase === 'ready';
  }

  /**
   * Check if the component was classified as non-economic (social/common good).
   * @returns {boolean}
   */
  isNonEconomic() {
    return this.state.space === 'social_good' || this.state.space === 'common_good';
  }

  /**
   * Check if the component was detected as a concrete named solution.
   * @returns {boolean}
   */
  isSolution() {
    return this.state.componentType === COMPONENT_TYPE.SOLUTION;
  }

  /**
   * Check if the component was detected as an abstract capability.
   * @returns {boolean}
   */
  isCapability() {
    return this.state.componentType === COMPONENT_TYPE.CAPABILITY;
  }

  /**
   * Check if the solution vs capability detection needs LLM fallback.
   * True when naming confidence is below the 90% threshold.
   * @returns {boolean}
   */
  needsComponentTypeFallback() {
    return this.state.componentTypeConfidence != null &&
      this.state.componentTypeConfidence < CONFIDENCE_THRESHOLD;
  }

  /**
   * Get the component type detection result from session state.
   * @returns {{ type: string|null, confidence: number|null, method: string|null, needsFallback: boolean }}
   */
  getComponentTypeDetection() {
    return {
      type: this.state.componentType,
      confidence: this.state.componentTypeConfidence,
      method: this.state.componentTypeMethod,
      needsFallback: this.needsComponentTypeFallback(),
    };
  }

  /**
   * Get the classification result for the current component.
   * @returns {import('../work-on-evolution/routing/classification-gate.mjs').ClassificationResult | null}
   */
  getClassification() {
    if (!this.state.name) return null;

    if (this.state.space) {
      const requiresReQuestion = this.state.space !== 'economic';
      return {
        space: this.state.space,
        reason: requiresReQuestion
          ? `"${this.state.name}" classified as ${this.state.space} during conversation.`
          : `"${this.state.name}" classified as economic — suitable for evolution evaluation.`,
        requiresReQuestion,
      };
    }

    return classifyComponent(this.state.name, this.state.description || '');
  }

  /**
   * Get re-questioning prompts for non-economic components.
   * @returns {string[]}
   */
  getReQuestions() {
    const classification = this.getClassification();
    if (!classification || !classification.requiresReQuestion) return [];
    return buildReQuestions(classification, this.state.name);
  }

  /**
   * Build the component input object for strategy evaluation.
   * Merges all gathered and inferred data.
   *
   * @returns {import('../work-on-evolution/strategies/capacity/base-strategy.mjs').ComponentInput}
   */
  buildComponentInput(): any {
    const input: any = {
      name: this.state.name,
      description: this.state.description || '',
      context: this.state.description || '',
    };

    // Add numeric fields if present
    const numericFields = ['certitude', 'ubiquity', 'wonder', 'build', 'operate', 'usage'];
    for (const field of numericFields) {
      if (this.state[field] != null) {
        input[field] = this.state[field];
      }
    }

    // Add metadata for LLM-based strategies
    input.metadata = {};
    if (this.state.sector) input.metadata.sector = this.state.sector;
    if (this.state.maturitySignals) input.metadata.maturitySignals = this.state.maturitySignals;
    if (this.state.marketDynamics) input.metadata.marketDynamics = this.state.marketDynamics;
    if (this.state.adoptionPattern) input.metadata.adoptionPattern = this.state.adoptionPattern;

    // Add solution routing metadata (detected during classification phase)
    if (this.state.componentType) {
      input.componentType = this.state.componentType;
      input.componentTypeConfidence = this.state.componentTypeConfidence;
      input.componentTypeMethod = this.state.componentTypeMethod;
      // Tag as solution for solution strategies
      if (this.state.componentType === COMPONENT_TYPE.SOLUTION) {
        input.isSolution = true;
      }
    }

    // Add solution-specific context for 12-property evaluation
    if (this.state.solutionContext) {
      input.solutionContext = this.state.solutionContext;
      input.metadata.solutionContext = this.state.solutionContext;
    }

    // ── Enrich context for solution components ──
    // When the component is a solution, compose a rich context string from all
    // conversational data gathered during the solution_context phase. This ensures
    // solution strategy LLM prompts receive the full conversational context
    // (not just the bare description) for accurate 12-property evaluation.
    if (this.state.componentType === COMPONENT_TYPE.SOLUTION) {
      const contextParts = [];
      if (this.state.description) contextParts.push(this.state.description);
      if (this.state.solutionContext) contextParts.push(this.state.solutionContext);
      if (this.state.marketDynamics) contextParts.push(`Market dynamics: ${this.state.marketDynamics}`);
      if (this.state.adoptionPattern) contextParts.push(`Adoption pattern: ${this.state.adoptionPattern}`);
      if (this.state.sector) contextParts.push(`Sector: ${this.state.sector}`);
      if (contextParts.length > 0) {
        input.context = contextParts.join('. ');
      }
    }

    return input;
  }

  /**
   * Get a summary of what has been gathered so far.
   * @returns {Object}
   */
  getSummary(): any {
    const gathered: any = {};
    const missing: any = {};

    // Base fields shared by both paths
    const baseFields = ['name', 'description', 'space'];

    // Path-specific fields
    const capabilityFields = [
      'certitude', 'ubiquity',
      'wonder', 'build', 'operate', 'usage',
      'sector', 'maturitySignals', 'marketDynamics', 'adoptionPattern',
    ];
    const solutionFields = [
      'solutionContext', 'marketDynamics', 'adoptionPattern',
    ];

    // Choose fields based on detected component type
    const isSolutionPath = this.state.componentType === COMPONENT_TYPE.SOLUTION;
    const fields = [
      ...baseFields,
      ...(isSolutionPath ? solutionFields : capabilityFields),
    ];

    for (const field of fields) {
      if (this.state[field] != null) {
        gathered[field] = this.state[field];
      } else {
        missing[field] = true;
      }
    }

    // Include component type info when available
    if (this.state.componentType) {
      gathered.componentType = this.state.componentType;
      gathered.componentTypeConfidence = this.state.componentTypeConfidence;
    }

    return {
      phase: this.state.phase,
      componentType: this.state.componentType,
      gathered,
      missing: Object.keys(missing),
      history: this.state.history,
      readyForEstimation: this.isReadyForEstimation(),
      exchangeCount: this.state.history.length,
    };
  }

  /**
   * Serialize session state for persistence across exchanges.
   * @returns {string}
   */
  serialize() {
    return JSON.stringify(this.state);
  }

  /**
   * Restore a session from serialized state.
   * @param {string} json
   * @returns {ConversationSession}
   */
  static deserialize(json) {
    const state = JSON.parse(json);
    return new ConversationSession(state);
  }

  // ─── Private Methods ────────────────────────────────────────────────────

  /**
   * Infer additional data from free-text fields.
   * Only fills in fields that are not already explicitly set.
   * @private
   */
  _inferFromContext() {
    // Infer certitude/ubiquity from maturity signals
    if (this.state.maturitySignals) {
      const inferred = inferFromMaturitySignals(this.state.maturitySignals);
      if (this.state.certitude == null && inferred.certitude != null) {
        this.state.certitude = inferred.certitude;
      }
      if (this.state.ubiquity == null && inferred.ubiquity != null) {
        this.state.ubiquity = inferred.ubiquity;
      }
    }

    // Infer publication proportions from market dynamics
    if (this.state.marketDynamics || this.state.adoptionPattern) {
      const hasPubs = this.state.wonder != null && this.state.build != null &&
                      this.state.operate != null && this.state.usage != null;
      if (!hasPubs) {
        const inferred = inferFromMarketSignals(
          this.state.marketDynamics,
          this.state.adoptionPattern
        );
        if (inferred.wonder != null) {
          if (this.state.wonder == null) this.state.wonder = inferred.wonder;
          if (this.state.build == null) this.state.build = inferred.build;
          if (this.state.operate == null) this.state.operate = inferred.operate;
          if (this.state.usage == null) this.state.usage = inferred.usage;
        }
      }
    }

    // Auto-classify if not yet classified
    if (this.state.name && this.state.space == null) {
      const classification = classifyComponent(this.state.name, this.state.description || '');
      this.state.space = classification.space;
    }

    // Detect solution vs capability type (once, after name is available)
    if (this.state.name && this.state.componentType == null) {
      const detection = detectComponentType(this.state.name, this.state.description || '');
      this.state.componentType = detection.type;
      this.state.componentTypeConfidence = detection.confidence;
      this.state.componentTypeMethod = detection.method;
    }
  }

  /**
   * Advance the conversation phase based on accumulated data.
   * @private
   */
  _advancePhase() {
    // Phase: identity → need name at minimum
    if (this.state.phase === 'identity') {
      if (this.state.name) {
        this.state.phase = 'classification';
      }
      // If we don't have name, stay in identity
      if (this.state.phase === 'identity') return;
    }

    // Phase: classification → need space resolved, then branch on component type
    if (this.state.phase === 'classification') {
      // Auto-classify if possible
      if (this.state.space == null && this.state.name) {
        const classification = classifyComponent(this.state.name, this.state.description || '');
        this.state.space = classification.space;
      }

      if (this.state.space) {
        // If non-economic, skip to ready (will trigger re-questioning)
        if (this.state.space !== 'economic') {
          this.state.phase = 'ready';
          return;
        }

        // ── Solution vs capability branching ──
        // After economic space is confirmed, branch based on component type.
        // Solutions go to solution_context; capabilities go to characteristics.
        if (this.state.componentType === COMPONENT_TYPE.SOLUTION) {
          this.state.phase = 'solution_context';
          this.state.history.push(
            `Classification: detected as solution (confidence=${this.state.componentTypeConfidence}, ` +
            `method=${this.state.componentTypeMethod}) — branching to solution path`
          );
        } else {
          this.state.phase = 'characteristics';
        }
      }
      if (this.state.phase === 'classification') return;
    }

    // ── Capability path phases ──

    // Phase: characteristics → need at least certitude OR ubiquity
    if (this.state.phase === 'characteristics') {
      if (this.state.certitude != null || this.state.ubiquity != null) {
        this.state.phase = 'market_signals';
      }
      if (this.state.phase === 'characteristics') return;
    }

    // Phase: market_signals → can proceed when we have some market data
    //   OR user explicitly wants to proceed
    if (this.state.phase === 'market_signals') {
      const hasPubs = this.state.wonder != null && this.state.build != null &&
                      this.state.operate != null && this.state.usage != null;
      const hasMarketText = this.state.marketDynamics || this.state.adoptionPattern;

      // Ready if we have either publication proportions or market text signals
      if (hasPubs || hasMarketText) {
        this.state.phase = 'ready';
      }
    }

    // ── Solution path phases ──

    // Phase: solution_context → can proceed when we have solution context or
    //   market dynamics or adoption pattern (any context for 12-property eval)
    if (this.state.phase === 'solution_context') {
      const hasSolutionContext = this.state.solutionContext != null;
      const hasMarketText = this.state.marketDynamics || this.state.adoptionPattern;

      // Ready if we have any solution-relevant context
      if (hasSolutionContext || hasMarketText) {
        this.state.phase = 'ready';
      }
    }
  }

  /**
   * Force the session to the ready phase.
   * Useful when the user wants to proceed with partial data.
   */
  forceReady() {
    if (this.state.name) {
      this.state.phase = 'ready';
      this.state.history.push('User requested early estimation with available data');
    }
  }
}

// ─── Self-test ──────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== ConversationSession self-test ===\n');

  // Test 1: Full multi-turn conversation
  console.log('--- Test 1: Full multi-turn conversation for ERP ---');
  const session1 = new ConversationSession();

  // Turn 1: Identity
  console.log(`Phase: ${session1.phase}`);
  const q1 = session1.nextQuestion();
  console.log(`Question: ${q1.prompt}`);

  session1.update({ name: 'ERP', description: 'Enterprise resource planning for large corporations' });
  console.log(`Phase after identity: ${session1.phase}`);

  // Turn 2: Classification auto-detected
  console.log(`Space: ${session1.state.space}`);
  console.log(`Phase after classification: ${session1.phase}`);

  // Turn 3: Characteristics
  const q3 = session1.nextQuestion();
  console.log(`Question: ${q3.prompt}`);
  session1.update({ certitude: 0.9, ubiquity: 0.85 });
  console.log(`Phase after characteristics: ${session1.phase}`);

  // Turn 4: Market signals
  const q4 = session1.nextQuestion();
  console.log(`Question: ${q4.prompt}`);
  session1.update({ wonder: 0.02, build: 0.08, operate: 0.25, usage: 0.65 });
  console.log(`Phase after market signals: ${session1.phase}`);

  console.log(`Ready: ${session1.isReadyForEstimation()}`);
  console.log(`Component input:`, JSON.stringify(session1.buildComponentInput(), null, 2));
  console.log(`Summary:`, JSON.stringify(session1.getSummary(), null, 2));
  console.log();

  // Test 2: Social good — should stop at classification
  console.log('--- Test 2: Social good (Air) — early stop ---');
  const session2 = new ConversationSession();
  session2.update({ name: 'Air', description: 'Atmospheric oxygen available to grow crops' });
  console.log(`Phase: ${session2.phase}`);
  console.log(`Non-economic: ${session2.isNonEconomic()}`);
  console.log(`Re-questions:`, session2.getReQuestions());
  console.log();

  // Test 3: Free-text inference — Kubernetes detected as SOLUTION
  console.log('--- Test 3: Solution detection — Kubernetes branches to solution_context ---');
  const session3 = new ConversationSession();
  session3.update({ name: 'Kubernetes', description: 'Container orchestration platform' });
  console.log(`Component type: ${session3.state.componentType}`);
  console.log(`Type confidence: ${session3.state.componentTypeConfidence}`);
  console.log(`Type method: ${session3.state.componentTypeMethod}`);
  console.log(`Phase after identity: ${session3.phase}`);
  console.assert(session3.state.componentType === 'solution', 'Kubernetes should be detected as solution');
  console.assert(session3.phase === 'solution_context', 'Should branch to solution_context phase');
  console.assert(session3.isSolution(), 'isSolution() should return true');

  // Solution path: provide solution context
  session3.update({
    solutionContext: 'Dominant container orchestration platform, CNCF project, widely adopted by enterprises',
  });
  console.log(`Phase after solution context: ${session3.phase}`);
  console.assert(session3.phase === 'ready', 'Should be ready after solution context');
  console.log(`Summary:`, JSON.stringify(session3.getSummary(), null, 2));
  console.log();

  // Test 3b: Capability detection — "container orchestration" stays on capability path
  console.log('--- Test 3b: Capability detection — branches to characteristics ---');
  const session3b = new ConversationSession();
  session3b.update({ name: 'container orchestration', description: 'Managing container workloads' });
  console.log(`Component type: ${session3b.state.componentType}`);
  console.log(`Phase: ${session3b.phase}`);
  console.assert(session3b.state.componentType === 'capability', 'container orchestration should be capability');
  console.assert(session3b.phase === 'characteristics', 'Should stay on capability path (characteristics)');
  console.assert(session3b.isCapability(), 'isCapability() should return true');
  console.assert(!session3b.isSolution(), 'isSolution() should return false');
  console.log();

  // Test 3c: Free-text inference (capability path)
  console.log('--- Test 3c: Free-text inference on capability path ---');
  const session3c = new ConversationSession();
  session3c.update({ name: 'monitoring', description: 'System monitoring capability' });
  session3c.update({
    maturitySignals: 'Well understood technology with established best practices, widely adopted by enterprises',
  });
  console.log(`Inferred certitude: ${session3c.state.certitude}`);
  console.log(`Inferred ubiquity: ${session3c.state.ubiquity}`);
  session3c.update({
    marketDynamics: 'Many competitors, feature differentiation, dominant players',
    adoptionPattern: 'Mass adoption in enterprise, mainstream',
  });
  console.log(`Inferred wonder: ${session3c.state.wonder}`);
  console.log(`Inferred build: ${session3c.state.build}`);
  console.log(`Phase: ${session3c.phase}`);
  console.log(`Summary:`, JSON.stringify(session3c.getSummary(), null, 2));
  console.log();

  // Test 4: Serialization
  console.log('--- Test 4: Serialization ---');
  const json = session1.serialize();
  const restored = ConversationSession.deserialize(json);
  console.log(`Restored phase: ${restored.phase}`);
  console.log(`Restored name: ${restored.state.name}`);
  console.assert(restored.state.name === 'ERP', 'Name should be restored');
  console.assert(restored.isReadyForEstimation(), 'Should still be ready');
  console.log();

  // Test 5: Force ready with partial data
  console.log('--- Test 5: Force ready with partial data ---');
  const session5 = new ConversationSession();
  session5.update({ name: 'LLM', description: 'Large language model for text generation' });
  console.log(`Phase before force: ${session5.phase}`);
  session5.forceReady();
  console.log(`Phase after force: ${session5.phase}`);
  console.assert(session5.isReadyForEstimation(), 'Should be ready after force');
  console.log();

  console.log('=== All ConversationSession self-tests completed ===');
}
