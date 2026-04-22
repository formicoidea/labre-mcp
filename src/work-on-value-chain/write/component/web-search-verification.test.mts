// Tests for web-search-verification.mjs
//
// Verifies:
//   1. Response parsing (structured, minimal, unstructured, edge cases)
//   2. Evidence block extraction (types, supports, sources)
//   3. References block extraction (title, url, snippet)
//   4. Main verification function with mock web search
//   5. Error handling and graceful degradation
//   6. Integration helper (combineWithPriorResult)
//   7. Confidence clamping and edge cases

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import '../../../lib/prompts/init.mjs';
import {
  parseWebSearchResponse,
  verifyViaWebSearch,
  combineWithPriorResult,
  createWebSearchCall,
} from './web-search-verification.mjs';
import { loadPromptsConfig } from '../../../lib/prompts/config.loader.mjs';

// ─── Mock Web Search Helpers ────────────────────────────────────────────────

/**
 * Create a mock web search function that returns a canned response.
 *
 * @param {'solution'|'capability'} classification
 * @param {number} confidence
 * @param {string} reasoning
 * @param {Object} [extras]
 * @param {string} [extras.evidenceLines] - Raw evidence lines
 * @param {string} [extras.referenceLines] - Raw reference lines
 * @returns {function(string): Promise<string>}
 */
function mockWebSearch(classification, confidence, reasoning, extras = {}) {
  const classUpper = classification.toUpperCase();
  let response = `classification=${classUpper}\nconfidence=${confidence.toFixed(2)}\nreasoning=${reasoning}`;

  if (extras.evidenceLines) {
    response += `\nEVIDENCE_START\n${extras.evidenceLines}\nEVIDENCE_END`;
  }
  if (extras.referenceLines) {
    response += `\nREFERENCES_START\n${extras.referenceLines}\nREFERENCES_END`;
  }

  return async () => response;
}

/**
 * Create a mock web search that throws an error.
 */
function failingWebSearch(errorMessage = 'Search unavailable') {
  return async () => { throw new Error(errorMessage); };
}

/**
 * Create a mock that records whether it was called and with what prompt.
 */
function spyWebSearch(returnValue) {
  const spy = async (prompt) => {
    spy.called = true;
    spy.lastPrompt = prompt;
    return returnValue;
  };
  spy.called = false;
  spy.lastPrompt = null;
  return spy;
}

// ─── Response Parsing ───────────────────────────────────────────────────────

describe('parseWebSearchResponse', () => {

  describe('well-formatted responses', () => {

    it('parses a complete solution response with evidence and references', () => {
      const response = [
        'classification=SOLUTION',
        'confidence=0.94',
        'reasoning=Kubernetes is a container orchestration platform by CNCF',
        'EVIDENCE_START',
        'type=product-page|description=Official site kubernetes.io|source=kubernetes.io|supports=solution',
        'type=wikipedia|description=Wikipedia article on Kubernetes|source=en.wikipedia.org|supports=solution',
        'type=repository|description=GitHub repo with 100k stars|source=github.com/kubernetes|supports=solution',
        'EVIDENCE_END',
        'REFERENCES_START',
        'title=Kubernetes|url=https://kubernetes.io|snippet=Production-grade container orchestration',
        'title=Kubernetes - Wikipedia|url=https://en.wikipedia.org/wiki/Kubernetes|snippet=Open-source container orchestration system',
        'REFERENCES_END',
      ].join('\n');

      const result = parseWebSearchResponse(response, 'Kubernetes');

      assert.equal(result.classification, 'solution');
      assert.equal(result.confidence, 0.94);
      assert.equal(result.method, 'web-search');
      assert.equal(result.isSolution, true);
      assert.ok(result.reasoning.includes('Kubernetes'));

      // Evidence
      assert.equal(result.evidence.length, 3);
      assert.equal(result.evidence[0].type, 'product-page');
      assert.equal(result.evidence[0].supports, 'solution');
      assert.ok(result.evidence[0].source.includes('kubernetes.io'));
      assert.equal(result.evidence[1].type, 'wikipedia');
      assert.equal(result.evidence[2].type, 'repository');

      // References
      assert.equal(result.references.length, 2);
      assert.equal(result.references[0].title, 'Kubernetes');
      assert.ok(result.references[0].url.includes('kubernetes.io'));
      assert.ok(result.references[0].snippet.includes('container orchestration'));
    });

    it('parses a complete capability response', () => {
      const response = [
        'classification=CAPABILITY',
        'confidence=0.88',
        'reasoning=Container orchestration is a general concept implemented by many tools',
        'EVIDENCE_START',
        'type=concept-article|description=Wikipedia concept article|source=en.wikipedia.org|supports=capability',
        'type=multi-implementation|description=Kubernetes, Docker Swarm, Nomad all implement this|source=various|supports=capability',
        'EVIDENCE_END',
        'REFERENCES_START',
        'title=Container orchestration - Wikipedia|url=https://en.wikipedia.org/wiki/Container_orchestration|snippet=Automated management of containers',
        'REFERENCES_END',
      ].join('\n');

      const result = parseWebSearchResponse(response, 'container orchestration');

      assert.equal(result.classification, 'capability');
      assert.equal(result.confidence, 0.88);
      assert.equal(result.isSolution, false);
      assert.equal(result.evidence.length, 2);
      assert.equal(result.evidence[0].supports, 'capability');
      assert.equal(result.evidence[1].type, 'multi-implementation');
      assert.equal(result.references.length, 1);
    });

    it('handles case-insensitive classification values', () => {
      const r1 = parseWebSearchResponse('classification=solution\nconfidence=0.80\nreasoning=test', 'x');
      assert.equal(r1.classification, 'solution');

      const r2 = parseWebSearchResponse('classification=CAPABILITY\nconfidence=0.80\nreasoning=test', 'x');
      assert.equal(r2.classification, 'capability');
    });

    it('handles spaces around equals sign', () => {
      const response = 'classification = SOLUTION\nconfidence = 0.85\nreasoning = It is a product';
      const result = parseWebSearchResponse(response, 'test');
      assert.equal(result.classification, 'solution');
      assert.equal(result.confidence, 0.85);
    });
  });

  describe('minimal responses (no evidence/references)', () => {

    it('parses classification without evidence blocks', () => {
      const response = 'classification=SOLUTION\nconfidence=0.75\nreasoning=Docker is a containerization platform';
      const result = parseWebSearchResponse(response, 'Docker');

      assert.equal(result.classification, 'solution');
      assert.equal(result.confidence, 0.75);
      assert.equal(result.evidence.length, 0);
      assert.equal(result.references.length, 0);
    });

    it('defaults confidence to 0.70 when missing', () => {
      const response = 'classification=SOLUTION\nreasoning=It is a product';
      const result = parseWebSearchResponse(response, 'test');
      assert.equal(result.confidence, 0.70);
    });

    it('generates default reasoning when missing', () => {
      const response = 'classification=CAPABILITY\nconfidence=0.80';
      const result = parseWebSearchResponse(response, 'CRM');
      assert.ok(result.reasoning.includes('CRM'));
    });
  });

  describe('unstructured responses (keyword inference)', () => {

    it('infers solution from product-related keywords', () => {
      const response = `After searching, I found that Docker has an official website at docker.com,
was developed by Docker Inc, and is a specific software platform. It has pricing for Docker Desktop
and is available for download. It is a commercial product with open-source components.`;

      const result = parseWebSearchResponse(response, 'Docker');
      assert.equal(result.classification, 'solution');
      assert.ok(result.confidence >= 0.50, `Confidence too low: ${result.confidence}`);
    });

    it('infers capability from concept-related keywords', () => {
      const response = `Container orchestration is a general concept and methodology for managing containers.
It is an abstract capability with multiple implementations including Kubernetes, Docker Swarm, and Nomad.
It is a category of tools rather than a specific product.`;

      const result = parseWebSearchResponse(response, 'container orchestration');
      assert.equal(result.classification, 'capability');
      assert.ok(result.confidence >= 0.50, `Confidence too low: ${result.confidence}`);
    });

    it('defaults to capability when no clear keywords found', () => {
      const response = 'I could not find any clear information about this component.';
      const result = parseWebSearchResponse(response, 'XyzWidget');
      assert.equal(result.classification, 'capability');
      assert.equal(result.confidence, 0.40);
    });
  });

  describe('confidence clamping', () => {

    it('clamps confidence above 1 to 1.0', () => {
      const response = 'classification=SOLUTION\nconfidence=1.50\nreasoning=test';
      const result = parseWebSearchResponse(response, 'test');
      assert.equal(result.confidence, 1.0);
    });

    it('clamps negative confidence to 0.0', () => {
      const response = 'classification=SOLUTION\nconfidence=-0.5\nreasoning=test';
      const result = parseWebSearchResponse(response, 'test');
      assert.equal(result.confidence, 0.0);
    });
  });

  describe('edge cases', () => {

    it('handles empty string', () => {
      const result = parseWebSearchResponse('', 'test');
      assert.equal(result.classification, 'capability');
      assert.equal(result.confidence, 0.40);
      assert.equal(result.evidence.length, 0);
    });

    it('handles null input', () => {
      const result = parseWebSearchResponse(null, 'test');
      assert.equal(result.classification, 'capability');
      assert.equal(result.confidence, 0.40);
    });

    it('handles undefined input', () => {
      const result = parseWebSearchResponse(undefined, 'test');
      assert.equal(result.classification, 'capability');
      assert.equal(result.confidence, 0.40);
    });

    it('handles response with preamble before classification', () => {
      const response = [
        'Let me search and analyze this component.',
        '',
        'classification=SOLUTION',
        'confidence=0.90',
        'reasoning=It is a named product',
      ].join('\n');

      const result = parseWebSearchResponse(response, 'test');
      assert.equal(result.classification, 'solution');
      assert.equal(result.confidence, 0.90);
    });
  });

  describe('evidence parsing details', () => {

    it('normalizes evidence types to known set', () => {
      const response = [
        'classification=SOLUTION',
        'confidence=0.80',
        'reasoning=test',
        'EVIDENCE_START',
        'type=Product Page|description=found it|source=example.com|supports=solution',
        'type=unknown_type|description=something|source=other.com|supports=solution',
        'type=vendor-association|description=by Google|source=google.com|supports=solution',
        'EVIDENCE_END',
      ].join('\n');

      const result = parseWebSearchResponse(response, 'test');
      assert.equal(result.evidence[0].type, 'product-page');  // normalized from "Product Page"
      assert.equal(result.evidence[1].type, 'generic');        // unknown → generic
      assert.equal(result.evidence[2].type, 'vendor-association');
    });

    it('handles evidence lines with missing optional fields', () => {
      const response = [
        'classification=SOLUTION',
        'confidence=0.80',
        'reasoning=test',
        'EVIDENCE_START',
        'type=generic|description=found something about it',
        'EVIDENCE_END',
      ].join('\n');

      const result = parseWebSearchResponse(response, 'test');
      assert.equal(result.evidence.length, 1);
      assert.equal(result.evidence[0].type, 'generic');
      assert.equal(result.evidence[0].description, 'found something about it');
      assert.equal(result.evidence[0].source, undefined);
    });

    it('skips malformed evidence lines', () => {
      const response = [
        'classification=SOLUTION',
        'confidence=0.80',
        'reasoning=test',
        'EVIDENCE_START',
        'this is not a valid evidence line',
        'type=product-page|description=valid line|source=example.com|supports=solution',
        '',
        'EVIDENCE_END',
      ].join('\n');

      const result = parseWebSearchResponse(response, 'test');
      assert.equal(result.evidence.length, 1);
      assert.equal(result.evidence[0].type, 'product-page');
    });
  });
});

// ─── Main Verification Function ─────────────────────────────────────────────

describe('verifyViaWebSearch', () => {

  describe('successful verification', () => {

    it('classifies known solution using mock web search', async () => {
      const search = mockWebSearch('solution', 0.95, 'Kubernetes is a CNCF platform', {
        evidenceLines: 'type=product-page|description=kubernetes.io|source=kubernetes.io|supports=solution',
        referenceLines: 'title=Kubernetes|url=https://kubernetes.io|snippet=Container orchestration',
      });

      const result = await verifyViaWebSearch('Kubernetes', { webSearchCall: search });

      assert.equal(result.classification, 'solution');
      assert.equal(result.confidence, 0.95);
      assert.equal(result.method, 'web-search');
      assert.equal(result.isSolution, true);
      assert.equal(result.evidence.length, 1);
      assert.equal(result.references.length, 1);
    });

    it('classifies known capability using mock web search', async () => {
      const search = mockWebSearch('capability', 0.88, 'CRM is an abstract business capability', {
        evidenceLines: 'type=multi-implementation|description=Salesforce, HubSpot, Zoho all provide CRM|source=various|supports=capability',
      });

      const result = await verifyViaWebSearch('CRM', { webSearchCall: search });

      assert.equal(result.classification, 'capability');
      assert.equal(result.confidence, 0.88);
      assert.equal(result.isSolution, false);
    });

    it('passes component name to web search prompt', async () => {
      const spy = spyWebSearch('classification=SOLUTION\nconfidence=0.80\nreasoning=test');

      await verifyViaWebSearch('Salesforce', { webSearchCall: spy });

      assert.equal(spy.called, true);
      assert.ok(spy.lastPrompt.includes('Salesforce'),
        'Component name should appear in the search prompt');
    });

    it('includes context in web search prompt when provided', async () => {
      const spy = spyWebSearch('classification=SOLUTION\nconfidence=0.80\nreasoning=test');

      await verifyViaWebSearch('MyProduct', {
        webSearchCall: spy,
        context: 'a cloud deployment tool',
      });

      assert.ok(spy.lastPrompt.includes('cloud deployment tool'),
        'Context should appear in the search prompt');
    });
  });

  describe('error handling', () => {

    it('returns graceful fallback when web search throws', async () => {
      const search = failingWebSearch('Network timeout');

      const result = await verifyViaWebSearch('SomeProduct', { webSearchCall: search });

      assert.equal(result.classification, 'capability');
      assert.ok(result.confidence <= 0.40, `Expected low confidence, got ${result.confidence}`);
      assert.ok(result.reasoning.includes('Network timeout'));
      assert.equal(result.error, 'Network timeout');
      assert.equal(result.evidence.length, 0);
      assert.equal(result.references.length, 0);
    });

    it('returns fallback for empty component name', async () => {
      const search = mockWebSearch('solution', 0.95, 'test');

      const result = await verifyViaWebSearch('', { webSearchCall: search });

      assert.equal(result.classification, 'capability');
      assert.equal(result.confidence, 0.40);
    });

    it('returns fallback for null component name', async () => {
      const search = mockWebSearch('solution', 0.95, 'test');

      const result = await verifyViaWebSearch(null, { webSearchCall: search });

      assert.equal(result.classification, 'capability');
      assert.equal(result.confidence, 0.40);
    });

    it('throws when webSearchCall is not a function and not omitted', async () => {
      await assert.rejects(
        () => verifyViaWebSearch('test', { webSearchCall: 'not a function' }),
        /requires a webSearchCall function/
      );
    });
  });
});

// ─── Combine With Prior Result ──────────────────────────────────────────────

describe('combineWithPriorResult', () => {

  const makePrior = (classification, confidence, method = 'naming') => ({
    classification,
    confidence,
    method,
    reasoning: `Prior ${method} result`,
  });

  const makeWeb = (classification, confidence) => ({
    classification,
    confidence,
    method: 'web-search',
    reasoning: `Web search found evidence`,
    isSolution: classification === 'solution',
    evidence: [],
    references: [],
  });

  describe('agreement (same classification)', () => {

    it('boosts confidence when both say solution', () => {
      const prior = makePrior('solution', 0.70);
      const web = makeWeb('solution', 0.90);

      const combined = combineWithPriorResult(prior, web);

      assert.equal(combined.classification, 'solution');
      // Agreement bonus (+0.10) should push combined above the average
      const average = (prior.confidence + web.confidence) / 2;
      assert.ok(combined.confidence >= average + 0.05,
        `Expected boosted confidence >= ${average + 0.05}, got ${combined.confidence}`);
      assert.ok(combined.method.includes('naming'));
      assert.ok(combined.method.includes('web-search'));
    });

    it('boosts confidence when both say capability', () => {
      const prior = makePrior('capability', 0.75, 'llm');
      const web = makeWeb('capability', 0.85);

      const combined = combineWithPriorResult(prior, web);

      assert.equal(combined.classification, 'capability');
      const average = (prior.confidence + web.confidence) / 2;
      assert.ok(combined.confidence > average,
        `Expected boosted above average ${average}, got ${combined.confidence}`);
    });

    it('caps boosted confidence at 0.98', () => {
      const prior = makePrior('solution', 0.97);
      const web = makeWeb('solution', 0.98);

      const combined = combineWithPriorResult(prior, web);
      assert.ok(combined.confidence <= 0.98,
        `Expected capped at 0.98, got ${combined.confidence}`);
    });
  });

  describe('disagreement (different classification)', () => {

    it('trusts web search over naming when they disagree', () => {
      const prior = makePrior('capability', 0.70);
      const web = makeWeb('solution', 0.85);

      const combined = combineWithPriorResult(prior, web);

      assert.equal(combined.classification, 'solution', 'Web search should win');
      assert.ok(combined.confidence < web.confidence,
        `Expected reduced confidence < ${web.confidence}, got ${combined.confidence}`);
    });

    it('trusts web search over LLM when they disagree', () => {
      const prior = makePrior('solution', 0.80, 'llm');
      const web = makeWeb('capability', 0.75);

      const combined = combineWithPriorResult(prior, web);

      assert.equal(combined.classification, 'capability', 'Web search should win');
      assert.ok(combined.confidence >= 0.45,
        `Expected minimum confidence >= 0.45, got ${combined.confidence}`);
    });

    it('preserves web search evidence and references', () => {
      const prior = makePrior('capability', 0.70);
      const web = {
        ...makeWeb('solution', 0.85),
        evidence: [{ type: 'product-page', description: 'found it', supports: 'solution' }],
        references: [{ title: 'Test Page', url: 'https://test.com' }],
      };

      const combined = combineWithPriorResult(prior, web);

      assert.equal(combined.evidence.length, 1);
      assert.equal(combined.references.length, 1);
    });
  });

  describe('edge cases', () => {

    it('returns web result when prior is null', () => {
      const web = makeWeb('solution', 0.80);
      const combined = combineWithPriorResult(null, web);
      assert.equal(combined.classification, 'solution');
      assert.equal(combined.confidence, 0.80);
    });

    it('returns prior result when web is null', () => {
      const prior = makePrior('capability', 0.70);
      const combined = combineWithPriorResult(prior, null);
      assert.equal(combined.classification, 'capability');
    });

    it('returns fallback when both are null', () => {
      const combined = combineWithPriorResult(null, null);
      assert.equal(combined.classification, 'capability');
    });

    it('handles prior with "type" field instead of "classification"', () => {
      // Router module uses "type" instead of "classification"
      const prior = { type: 'solution', confidence: 0.75, method: 'known-solution', reasoning: 'dictionary match' };
      const web = makeWeb('solution', 0.90);

      const combined = combineWithPriorResult(prior, web);
      assert.equal(combined.classification, 'solution');
      // Agreement between prior and web should boost above their average
      const average = (prior.confidence + web.confidence) / 2;
      assert.ok(combined.confidence > average,
        `Expected boosted above average ${average}, got ${combined.confidence}`);
    });
  });
});

// ─── Prompt Template ────────────────────────────────────────────────────────

describe('web-search-verification template', () => {
  const template = loadPromptsConfig().templates['web-search-verification'].default.text;

  it('is non-empty', () => {
    assert.ok(template.length > 100);
  });

  it('contains required template placeholders', () => {
    assert.ok(template.includes('{{name}}'), 'Prompt must contain {{name}} placeholder');
    assert.ok(template.includes('{{context_line}}'), 'Prompt must contain {{context_line}} placeholder');
  });

  it('mentions both SOLUTION and CAPABILITY', () => {
    assert.ok(template.includes('SOLUTION'));
    assert.ok(template.includes('CAPABILITY'));
  });

  it('includes evidence format instructions', () => {
    assert.ok(template.includes('EVIDENCE_START'));
    assert.ok(template.includes('EVIDENCE_END'));
    assert.ok(template.includes('REFERENCES_START'));
    assert.ok(template.includes('REFERENCES_END'));
  });
});

// ─── createWebSearchCall Factory ────────────────────────────────────────────

describe('createWebSearchCall', () => {

  it('returns a function', () => {
    // NOTE: We can't actually run this because it requires the Agent SDK
    // runtime. But we verify the factory pattern works.
    const fn = createWebSearchCall();
    assert.equal(typeof fn, 'function');
  });

  it('accepts custom configuration', () => {
    const fn = createWebSearchCall({
      model: 'claude-haiku-4-5',
      maxTurns: 2,
    });
    assert.equal(typeof fn, 'function');
  });
});

// ─── Routing Accuracy (evaluation criterion) ─────────────────────────────────

describe('routing accuracy with web search verification', () => {

  describe('correctly classifies known solutions via web evidence', () => {

    const solutionScenarios = [
      {
        name: 'Kubernetes',
        evidence: 'type=product-page|description=kubernetes.io official site|source=kubernetes.io|supports=solution',
        reasoning: 'Kubernetes is a specific container orchestration platform by CNCF',
      },
      {
        name: 'Salesforce',
        evidence: 'type=product-page|description=salesforce.com CRM platform|source=salesforce.com|supports=solution\ntype=pricing|description=Enterprise pricing page|source=salesforce.com/pricing|supports=solution',
        reasoning: 'Salesforce is a commercial CRM platform by Salesforce Inc',
      },
      {
        name: 'SAP ERP',
        evidence: 'type=vendor-association|description=Enterprise resource planning by SAP SE|source=sap.com|supports=solution',
        reasoning: 'SAP ERP is a specific enterprise software product by SAP SE',
      },
    ];

    for (const scenario of solutionScenarios) {
      it(`"${scenario.name}" classified as solution via web evidence`, async () => {
        const search = mockWebSearch('solution', 0.92, scenario.reasoning, {
          evidenceLines: scenario.evidence,
        });

        const result = await verifyViaWebSearch(scenario.name, { webSearchCall: search });

        assert.equal(result.classification, 'solution',
          `"${scenario.name}" should be classified as solution`);
        assert.ok(result.confidence >= 0.85,
          `Expected high confidence for "${scenario.name}", got ${result.confidence}`);
        assert.ok(result.evidence.length >= 1,
          `Expected evidence for "${scenario.name}"`);
      });
    }
  });

  describe('correctly classifies known capabilities via web evidence', () => {

    const capabilityScenarios = [
      {
        name: 'container orchestration',
        evidence: 'type=multi-implementation|description=Kubernetes, Docker Swarm, Nomad|source=various|supports=capability',
        reasoning: 'Container orchestration is a general concept with multiple implementations',
      },
      {
        name: 'CRM',
        evidence: 'type=concept-article|description=CRM is a business strategy and capability|source=wikipedia|supports=capability\ntype=multi-implementation|description=Salesforce, HubSpot, Zoho, Dynamics 365|source=various|supports=capability',
        reasoning: 'CRM describes a business capability, not a specific product',
      },
    ];

    for (const scenario of capabilityScenarios) {
      it(`"${scenario.name}" classified as capability via web evidence`, async () => {
        const search = mockWebSearch('capability', 0.88, scenario.reasoning, {
          evidenceLines: scenario.evidence,
        });

        const result = await verifyViaWebSearch(scenario.name, { webSearchCall: search });

        assert.equal(result.classification, 'capability',
          `"${scenario.name}" should be classified as capability`);
        assert.ok(result.confidence >= 0.80,
          `Expected reasonable confidence for "${scenario.name}", got ${result.confidence}`);
      });
    }
  });
});
