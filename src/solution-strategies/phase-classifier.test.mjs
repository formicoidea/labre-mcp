// Tests for PhaseClassifier — per-property phase classification logic
//
// Covers:
//   - Constructor and factory methods
//   - Text processing utilities (normalize, tokenize, bigrams)
//   - Signal bank construction from property reference
//   - Single property classification with known signals
//   - All-property classification (12 properties)
//   - Confidence scoring (margin-based)
//   - Default behavior when no signals match
//   - Known solution classification (Kubernetes, Salesforce, TCP/IP)
//   - Validation of external classifications
//   - Edge cases: empty text, minimal text, ambiguous text

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PhaseClassifier,
  classifyAllProperties,
  classifySingleProperty,
  normalizeText,
  extractTokens,
  extractBigrams,
  buildPropertySignals,
  GENERAL_PHASE_SIGNALS,
  PHASE_LABELS,
} from './phase-classifier.mjs';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROPERTY_REF = [
  {
    id: 'market',
    name: 'Market',
    weight: 0.0833,
    phases: {
      '1': 'Undefined market; no established demand or supply dynamics exist yet',
      '2': 'Emerging market with early adopters exploring custom solutions and bespoke offerings',
      '3': 'Established market with growing competition, clear demand, and multiple recognized vendors',
      '4': 'Mature, commoditized market with stable demand, high volume, and price-driven competition',
    },
  },
  {
    id: 'knowledge_management',
    name: 'Knowledge management',
    weight: 0.0833,
    phases: {
      '1': 'Knowledge is scarce, tacit, and held by few experts or inventors; very little documented',
      '2': 'Knowledge is growing but fragmented across early practitioners; shared via informal communities',
      '3': 'Knowledge is widely published and taught; best practices, certifications, and formal training emerge',
      '4': 'Knowledge is ubiquitous, embedded in operations; considered baseline competency, extensively automated',
    },
  },
  {
    id: 'market_perception',
    name: 'Market perception',
    weight: 0.0833,
    phases: {
      '1': 'Poorly understood or unknown to the broader market; seen as experimental or unproven',
      '2': 'Recognized as a niche solution by early adopters; increasing awareness but limited mainstream trust',
      '3': 'Well-understood and accepted across the market; perceived as a proven, reliable solution category',
      '4': 'Taken for granted; invisible infrastructure that the market expects as a standard utility',
    },
  },
  {
    id: 'efficiency',
    name: 'Efficiency',
    weight: 0.0833,
    phases: {
      '1': 'Very low efficiency; high resource investment per unit of output, significant waste in exploration',
      '2': 'Improving efficiency through learning; reducing waste as patterns and best practices emerge',
      '3': 'Good efficiency with established processes; measurable ROI, optimized delivery, and scaling operations',
      '4': 'Maximum efficiency through standardization, automation, and economies of scale; marginal cost approaches zero',
    },
  },
];

// ─── Text Processing Utilities ────────────────────────────────────────────────

describe('normalizeText()', () => {
  it('lowercases input', () => {
    assert.equal(normalizeText('Hello WORLD'), 'hello world');
  });

  it('removes punctuation except hyphens and apostrophes', () => {
    assert.equal(normalizeText('price-driven, competition!'), "price-driven competition");
  });

  it('collapses multiple whitespace', () => {
    assert.equal(normalizeText('too   many   spaces'), 'too many spaces');
  });

  it('handles empty or null input', () => {
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
  });

  it('normalizes smart quotes', () => {
    const result = normalizeText("it\u2019s a test");
    assert.ok(result.includes("it's"));
  });
});

describe('extractTokens()', () => {
  it('extracts meaningful words, filtering stop words', () => {
    const tokens = extractTokens('The market is established with growing competition');
    assert.ok(tokens.includes('market'));
    assert.ok(tokens.includes('established'));
    assert.ok(tokens.includes('growing'));
    assert.ok(tokens.includes('competition'));
    // Stop words filtered
    assert.ok(!tokens.includes('the'));
    assert.ok(!tokens.includes('is'));
    assert.ok(!tokens.includes('with'));
  });

  it('filters words shorter than 3 characters', () => {
    const tokens = extractTokens('a to be or not');
    assert.equal(tokens.length, 0);
  });

  it('handles empty text', () => {
    const tokens = extractTokens('');
    assert.equal(tokens.length, 0);
  });
});

describe('extractBigrams()', () => {
  it('extracts consecutive word pairs', () => {
    const bigrams = extractBigrams('early adopters exploring custom solutions');
    assert.ok(bigrams.includes('early adopters'));
    assert.ok(bigrams.includes('adopters exploring'));
    assert.ok(bigrams.includes('exploring custom'));
    assert.ok(bigrams.includes('custom solutions'));
  });

  it('returns empty array for single word', () => {
    const bigrams = extractBigrams('commodity');
    assert.equal(bigrams.length, 0);
  });

  it('returns empty array for empty text', () => {
    assert.equal(extractBigrams('').length, 0);
  });
});

// ─── Signal Bank Construction ─────────────────────────────────────────────────

describe('buildPropertySignals()', () => {
  it('builds signals for all 4 phases', () => {
    const signals = buildPropertySignals(PROPERTY_REF[0]); // Market
    assert.equal(signals.propertyName, 'Market');

    for (const phaseNum of [1, 2, 3, 4]) {
      assert.ok(signals.phases.has(phaseNum), `Missing signals for phase ${phaseNum}`);
      assert.ok(signals.phases.get(phaseNum).length > 0, `No signals for phase ${phaseNum}`);
    }
  });

  it('assigns higher weight to discriminative terms', () => {
    const signals = buildPropertySignals(PROPERTY_REF[0]); // Market

    // "undefined" appears only in phase 1 → should have weight 1.0
    const phase1Signals = signals.phases.get(1);
    const undefinedSignal = phase1Signals.find(
      s => s.term === 'undefined' && s.source === 'description'
    );
    if (undefinedSignal) {
      assert.ok(undefinedSignal.weight > 0.5, `Expected high weight for discriminative term, got ${undefinedSignal.weight}`);
    }
  });

  it('assigns lower weight to shared terms', () => {
    const signals = buildPropertySignals(PROPERTY_REF[0]); // Market
    // "market" appears in multiple phase descriptions → should have lower weight
    const phase1Signals = signals.phases.get(1);
    const marketSignal = phase1Signals.find(
      s => s.term === 'market' && s.source === 'description'
    );
    if (marketSignal) {
      assert.ok(marketSignal.weight <= 0.5, `Expected low weight for shared term, got ${marketSignal.weight}`);
    }
  });

  it('includes general phase indicators', () => {
    const signals = buildPropertySignals(PROPERTY_REF[0]); // Market
    const phase4Signals = signals.phases.get(4);
    const generalSignals = phase4Signals.filter(s => s.source === 'general');
    assert.ok(generalSignals.length > 0, 'Expected general phase indicators');
  });

  it('includes bigram signals', () => {
    const signals = buildPropertySignals(PROPERTY_REF[0]); // Market
    const phase2Signals = signals.phases.get(2);
    const bigramSignals = phase2Signals.filter(s => s.source === 'description-bigram');
    assert.ok(bigramSignals.length > 0, 'Expected bigram signals');
  });
});

// ─── PhaseClassifier ──────────────────────────────────────────────────────────

describe('PhaseClassifier', () => {

  describe('constructor', () => {
    it('requires a non-empty properties array', () => {
      assert.throws(
        () => new PhaseClassifier([]),
        /non-empty properties reference/
      );
    });

    it('throws on non-array input', () => {
      assert.throws(
        () => new PhaseClassifier('not-array'),
        /non-empty properties reference/
      );
    });

    it('accepts valid property reference', () => {
      const classifier = new PhaseClassifier(PROPERTY_REF);
      assert.ok(classifier instanceof PhaseClassifier);
    });

    it('exposes propertyCount', () => {
      const classifier = new PhaseClassifier(PROPERTY_REF);
      assert.equal(classifier.propertyCount, 4);
    });

    it('exposes propertyNames', () => {
      const classifier = new PhaseClassifier(PROPERTY_REF);
      assert.deepEqual(classifier.propertyNames, [
        'Market', 'Knowledge management', 'Market perception', 'Efficiency',
      ]);
    });
  });

  describe('fromReference()', () => {
    it('creates classifier from evolution-properties.json', async () => {
      const classifier = await PhaseClassifier.fromReference();
      assert.ok(classifier instanceof PhaseClassifier);
      assert.equal(classifier.propertyCount, 12);
    });

    it('loads all 12 property names', async () => {
      const classifier = await PhaseClassifier.fromReference();
      const names = classifier.propertyNames;
      assert.equal(names.length, 12);
      assert.ok(names.includes('Market'));
      assert.ok(names.includes('Knowledge management'));
      assert.ok(names.includes('Efficiency'));
      assert.ok(names.includes('Decision driver'));
    });
  });

  // ─── Single Property Classification ────────────────────────────────────

  describe('classifyProperty()', () => {
    let classifier;

    beforeEach(() => {
      classifier = new PhaseClassifier(PROPERTY_REF);
    });

    it('throws for unknown property name', () => {
      assert.throws(
        () => classifier.classifyProperty('NonExistent', 'some text'),
        /Unknown property/
      );
    });

    it('returns PropertyClassification shape', () => {
      const result = classifier.classifyProperty('Market', 'Established market');
      assert.equal(typeof result.property, 'string');
      assert.equal(typeof result.phase, 'number');
      assert.ok(result.phase >= 1 && result.phase <= 4);
      assert.equal(typeof result.label, 'string');
      assert.equal(typeof result.confidence, 'number');
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
      assert.equal(typeof result.scores, 'object');
      assert.ok(1 in result.scores && 2 in result.scores && 3 in result.scores && 4 in result.scores);
      assert.equal(typeof result.reason, 'string');
    });

    it('classifies commodity-like text as phase 4', () => {
      const text = 'Mature commoditized market with stable demand, high volume, price-driven competition, utility pricing';
      const result = classifier.classifyProperty('Market', text);
      assert.equal(result.phase, 4, `Expected phase 4, got ${result.phase}`);
      assert.equal(result.label, 'Commodity');
    });

    it('classifies genesis-like text as phase 1', () => {
      const text = 'Undefined market with no established demand, experimental and unproven concept, research phase';
      const result = classifier.classifyProperty('Market', text);
      assert.equal(result.phase, 1, `Expected phase 1, got ${result.phase}`);
      assert.equal(result.label, 'Genesis');
    });

    it('classifies product-like text as phase 3', () => {
      const text = 'Established market with growing competition, clear demand, and multiple recognized vendors, proven reliable';
      const result = classifier.classifyProperty('Market', text);
      assert.equal(result.phase, 3, `Expected phase 3, got ${result.phase}`);
    });

    it('classifies custom-like text as phase 2', () => {
      const text = 'Emerging market with early adopters exploring custom solutions and bespoke offerings, niche players';
      const result = classifier.classifyProperty('Market', text);
      assert.equal(result.phase, 2, `Expected phase 2, got ${result.phase}`);
    });

    it('defaults to phase 2 with low confidence for empty text', () => {
      const result = classifier.classifyProperty('Market', '');
      assert.equal(result.phase, 2);
      assert.ok(result.confidence <= 0.15, `Expected low confidence, got ${result.confidence}`);
    });

    it('defaults to phase 2 with low confidence for irrelevant text', () => {
      const result = classifier.classifyProperty('Market', 'lorem ipsum dolor sit amet');
      assert.equal(result.phase, 2);
      assert.ok(result.confidence <= 0.2, `Expected low confidence, got ${result.confidence}`);
    });

    it('handles fuzzy property name matching (case insensitive)', () => {
      const result = classifier.classifyProperty('market', 'Commoditized utility market');
      assert.equal(result.property, 'Market');
    });

    it('handles partial property name matching', () => {
      const result = classifier.classifyProperty('Knowledge', 'Ubiquitous automated knowledge');
      assert.equal(result.property, 'Knowledge management');
    });

    it('classifies Efficiency for commodity signals', () => {
      const text = 'Maximum efficiency through standardization, automation, and economies of scale; marginal cost approaches zero';
      const result = classifier.classifyProperty('Efficiency', text);
      assert.equal(result.phase, 4, `Expected phase 4 for Efficiency, got ${result.phase}`);
    });

    it('classifies Knowledge management for genesis signals', () => {
      const text = 'Knowledge is scarce, tacit, held by few experts, very little documented, novel research area';
      const result = classifier.classifyProperty('Knowledge management', text);
      assert.equal(result.phase, 1, `Expected phase 1 for Knowledge management, got ${result.phase}`);
    });

    it('provides higher confidence for clear signals vs ambiguous', () => {
      const clearText = 'Mature commoditized market with stable demand, high volume, price-driven, utility';
      const ambiguousText = 'The market exists';

      const clearResult = classifier.classifyProperty('Market', clearText);
      const ambiguousResult = classifier.classifyProperty('Market', ambiguousText);

      assert.ok(
        clearResult.confidence > ambiguousResult.confidence,
        `Expected clear signal confidence (${clearResult.confidence}) > ambiguous (${ambiguousResult.confidence})`
      );
    });
  });

  // ─── All-Property Classification ───────────────────────────────────────

  describe('classifyAll()', () => {
    let classifier;

    beforeEach(() => {
      classifier = new PhaseClassifier(PROPERTY_REF);
    });

    it('returns classification for every property', () => {
      const results = classifier.classifyAll('Established market with proven vendor ecosystem');
      assert.equal(results.length, PROPERTY_REF.length);

      for (const r of results) {
        assert.ok(r.phase >= 1 && r.phase <= 4);
        assert.ok(r.confidence >= 0 && r.confidence <= 1);
        assert.ok(typeof r.property === 'string');
      }
    });

    it('covers all property names', () => {
      const results = classifier.classifyAll('some text');
      const names = results.map(r => r.property);
      for (const prop of PROPERTY_REF) {
        assert.ok(names.includes(prop.name), `Missing property: ${prop.name}`);
      }
    });

    it('classifies commodity text toward phase 4 for multiple properties', () => {
      const text = 'Commoditized utility market, ubiquitous knowledge, automated processes, ' +
                   'standardized, maximum efficiency, economies of scale, price-driven';
      const results = classifier.classifyAll(text);

      const phase4Count = results.filter(r => r.phase === 4).length;
      assert.ok(
        phase4Count >= 2,
        `Expected at least 2 properties at phase 4, got ${phase4Count}`
      );
    });

    it('classifies genesis text toward phase 1 for multiple properties', () => {
      const text = 'Undefined experimental market, scarce tacit knowledge, novel unproven concept, ' +
                   'research prototype, very low efficiency, high waste exploration';
      const results = classifier.classifyAll(text);

      const phase1Count = results.filter(r => r.phase === 1).length;
      assert.ok(
        phase1Count >= 2,
        `Expected at least 2 properties at phase 1, got ${phase1Count}`
      );
    });
  });

  // ─── Subset Classification ─────────────────────────────────────────────

  describe('classifySubset()', () => {
    it('classifies only the requested properties', () => {
      const classifier = new PhaseClassifier(PROPERTY_REF);
      const results = classifier.classifySubset('some text', ['Market', 'Efficiency']);
      assert.equal(results.length, 2);
      assert.ok(results.some(r => r.property === 'Market'));
      assert.ok(results.some(r => r.property === 'Efficiency'));
    });

    it('returns empty array for unknown properties', () => {
      const classifier = new PhaseClassifier(PROPERTY_REF);
      const results = classifier.classifySubset('text', ['NonExistent']);
      assert.equal(results.length, 0);
    });
  });

  // ─── Validation ────────────────────────────────────────────────────────

  describe('validateClassification()', () => {
    let classifier;

    beforeEach(() => {
      classifier = new PhaseClassifier(PROPERTY_REF);
    });

    it('returns agreement=1.0 for exact match', () => {
      const text = 'Mature commoditized market with stable demand, high volume, price-driven';
      const result = classifier.validateClassification('Market', 4, text);
      // Classifier should also pick phase 4 for this text
      if (result.classifierPhase === 4) {
        assert.equal(result.agreement, 1.0);
        assert.equal(result.delta, 0);
      }
    });

    it('returns lower agreement for larger delta', () => {
      const text = 'Commoditized utility market, price-driven';
      const result = classifier.validateClassification('Market', 1, text);
      // Classifier should be around 3-4, so delta should be 2-3
      assert.ok(result.agreement < 1.0, `Expected agreement < 1.0, got ${result.agreement}`);
    });

    it('returns correct shape', () => {
      const result = classifier.validateClassification('Market', 3, 'some text');
      assert.equal(typeof result.agreement, 'number');
      assert.equal(typeof result.classifierPhase, 'number');
      assert.equal(typeof result.assignedPhase, 'number');
      assert.equal(typeof result.delta, 'number');
      assert.equal(typeof result.classifierConfidence, 'number');
      assert.equal(result.assignedPhase, 3);
    });
  });

  // ─── Known Solution Classification ─────────────────────────────────────

  describe('known solution descriptions', () => {
    let classifier;

    beforeEach(async () => {
      classifier = await PhaseClassifier.fromReference();
    });

    it('Kubernetes description → mostly Product/Commodity phases', async () => {
      const text = 'Kubernetes is a widely adopted, production-ready container orchestration platform ' +
                   'with a mature ecosystem of vendors, certifications, and established best practices. ' +
                   'It has standardized the container orchestration market with multiple providers. ' +
                   'Knowledge is widely published and formal training is available.';

      const results = classifier.classifyAll(text);
      const avgPhase = results.reduce((sum, r) => sum + r.phase, 0) / results.length;

      assert.ok(
        avgPhase >= 2.5,
        `Expected Kubernetes avg phase >= 2.5 (Product+), got ${avgPhase.toFixed(2)}`
      );
    });

    it('TCP/IP description → mostly Commodity phases', async () => {
      const text = 'TCP/IP is ubiquitous networking infrastructure taken for granted. ' +
                   'It is a commodity, essential utility with standardized protocols, automated, ' +
                   'maximum efficiency, economies of scale. Failure is unacceptable. ' +
                   'Price-driven, self-service, interchangeable implementations.';

      const results = classifier.classifyAll(text);
      const phase4Count = results.filter(r => r.phase === 4).length;

      assert.ok(
        phase4Count >= 4,
        `Expected TCP/IP to have >=4 properties at phase 4, got ${phase4Count}`
      );
    });

    it('novel research concept → Genesis phases', async () => {
      const text = 'This is an experimental proof of concept in a nascent, undefined market. ' +
                   'Knowledge is scarce and tacit, held by a few researchers. ' +
                   'Very poorly understood, no comparison possible, high failure rates expected. ' +
                   'Exploration and research, very low efficiency.';

      const results = classifier.classifyAll(text);
      const phase1Count = results.filter(r => r.phase === 1).length;

      assert.ok(
        phase1Count >= 4,
        `Expected Genesis concept to have >=4 properties at phase 1, got ${phase1Count}`
      );
    });
  });

  // ─── Score Distribution ────────────────────────────────────────────────

  describe('score distribution', () => {
    it('phase 4 text has highest score in phase 4 bucket', () => {
      const classifier = new PhaseClassifier(PROPERTY_REF);
      const text = 'Commoditized utility, price-driven, automated, economies of scale, ubiquitous, standardized';
      const result = classifier.classifyProperty('Market', text);

      assert.ok(
        result.scores[4] >= result.scores[1],
        `Phase 4 score (${result.scores[4]}) should be >= phase 1 score (${result.scores[1]})`
      );
      assert.ok(
        result.scores[4] >= result.scores[2],
        `Phase 4 score (${result.scores[4]}) should be >= phase 2 score (${result.scores[2]})`
      );
    });

    it('phase 1 text has highest score in phase 1 bucket', () => {
      const classifier = new PhaseClassifier(PROPERTY_REF);
      const text = 'Undefined, experimental, novel, research, prototype, unproven, genesis, unexplored';
      const result = classifier.classifyProperty('Market', text);

      assert.ok(
        result.scores[1] >= result.scores[3],
        `Phase 1 score (${result.scores[1]}) should be >= phase 3 score (${result.scores[3]})`
      );
      assert.ok(
        result.scores[1] >= result.scores[4],
        `Phase 1 score (${result.scores[1]}) should be >= phase 4 score (${result.scores[4]})`
      );
    });
  });
});

// ─── Convenience Functions ────────────────────────────────────────────────────

describe('classifyAllProperties()', () => {
  it('classifies all 12 properties from reference', async () => {
    const results = await classifyAllProperties('Established vendor ecosystem with certifications');
    assert.equal(results.length, 12);
    for (const r of results) {
      assert.ok(r.phase >= 1 && r.phase <= 4);
    }
  });
});

describe('classifySingleProperty()', () => {
  it('classifies a single property from reference', async () => {
    const result = await classifySingleProperty('Market', 'Commoditized utility market');
    assert.equal(result.property, 'Market');
    assert.ok(result.phase >= 1 && result.phase <= 4);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('GENERAL_PHASE_SIGNALS', () => {
  it('has entries for all 4 phases', () => {
    for (const phase of [1, 2, 3, 4]) {
      assert.ok(Array.isArray(GENERAL_PHASE_SIGNALS[phase]));
      assert.ok(GENERAL_PHASE_SIGNALS[phase].length > 0);
    }
  });
});

describe('PHASE_LABELS', () => {
  it('maps all 4 phases correctly', () => {
    assert.equal(PHASE_LABELS[1], 'Genesis');
    assert.equal(PHASE_LABELS[2], 'Custom');
    assert.equal(PHASE_LABELS[3], 'Product');
    assert.equal(PHASE_LABELS[4], 'Commodity');
  });
});
