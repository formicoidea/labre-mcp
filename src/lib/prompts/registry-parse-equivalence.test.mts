// Non-regression guarantee: every parser reachable via getPrompt(strategy, name).parse()
// produces the same output as calling the underlying parseXxx() directly.
//
// This locks the behavior of the registry round-trip so a future refactor
// (e.g. changing how getPrompt resolves its parser) cannot silently change
// what a tool returns to its caller.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import './init.mjs';
import { getPrompt } from './registry.mjs';

import { parseCapabilityResponse } from '#work-on-value-chain/write/component/lib/capability/identify-capability.mjs';
import { parseAnchorResponse } from '#work-on-evolution/write/strategies/anchor/estimate-anchor-evolution.mjs';
import { parsePubResponse } from '#work-on-evolution/write/strategies/capacity/publication-analysis-strategy.mjs';
import { parseFallbackPhase } from '#work-on-evolution/write/strategies/capacity/logprob-distribution-strategy.mjs';
import { parseHistoryIterationResponse } from '#work-on-evolution/write/strategies/capacity/timeline-benchmark-strategy.mjs';
import { parseLLMDirectResponse } from '#work-on-evolution/write/strategies/capacity/llm-direct-strategy.mjs';
import {
  parseCpcPickClass,
  parseCpcPickFromList,
  parseCpcFallback,
} from '#work-on-evolution/write/patent/cpc-mapper.mjs';
import { parseSolutionDiscoveryResponse } from '#work-on-evolution/write/pipeline/pipeline-enriched.mjs';
import { parseCpcSotExtraction } from '#work-on-evolution/write/strategies/capacity/cpc-evolution-strategy.mjs';
import { parseWebSearchResponse } from '#work-on-value-chain/write/component/lib/verification/web-search-verification.mjs';
import { parseLLMClassificationResponse } from '#work-on-evolution/write/routing/detect-solution.mjs';

describe('registry round-trip equivalence', () => {
  it('identifyCapability: registry.parse === parseCapabilityResponse', () => {
    const text = 'type=component\nnature=activity\ncapability=Orchestrate containers\nconfidence=0.88\njustification=clear naming';
    const ctx = { name: 'Kubernetes', type: 'component', context: 'cloud' };
    assert.deepEqual(
      getPrompt('identify-capability').parse(text, ctx),
      parseCapabilityResponse(text, ctx),
    );
  });

  it('anchorEvolution: registry.parse === parseAnchorResponse', () => {
    const text = 'phase=3\njustification=standard expectation\nconfidence=0.85';
    assert.deepEqual(
      getPrompt('anchor-evolution').parse(text),
      parseAnchorResponse(text),
    );
  });

  it('publicationPhases: registry.parse === parsePubResponse', () => {
    const text = 'phase1=0.10\nphase2=0.30\nphase3=0.40\nphase4=0.20';
    assert.deepEqual(
      getPrompt('publication-analysis').parse(text),
      parsePubResponse(text),
    );
  });

  it('logprobFallback: registry.parse === parseFallbackPhase', () => {
    const text = 'Phase3';
    assert.deepEqual(
      getPrompt('logprob-fallback').parse(text),
      parseFallbackPhase(text),
    );
  });

  it('timelineIteration: registry.parse === parseHistoryIterationResponse', () => {
    const text = 'milestone_name=Apollo 11\nmilestone_date=1969';
    assert.deepEqual(
      getPrompt('timeline-benchmark').parse(text),
      parseHistoryIterationResponse(text),
    );
  });

  it('llmDirect: registry.parse === parseLLMDirectResponse (both variants)', () => {
    const text = 'evolution=0.75\nconfidence=0.9';
    assert.deepEqual(
      getPrompt('historical-evolution', 'with-capability').parse(text),
      parseLLMDirectResponse(text),
    );
    assert.deepEqual(
      getPrompt('historical-evolution', 'without-capability').parse(text),
      parseLLMDirectResponse(text),
    );
  });

  it('cpcPickClass: registry.parse === parseCpcPickClass', () => {
    const text = 'The answer is G06 based on the capability.';
    assert.deepEqual(
      getPrompt('cpc-mapper', 'pick-class').parse(text),
      parseCpcPickClass(text),
    );
  });

  it('cpcPickFromList: registry.parse === parseCpcPickFromList', () => {
    const text = 'G06F\nG06N\nH04L';
    const ctx = { codeEntries: [{ code: 'G06F', cnt: 10 }, { code: 'G06N', cnt: 5 }] };
    assert.deepEqual(
      getPrompt('cpc-mapper', 'pick-from-list').parse(text, ctx),
      parseCpcPickFromList(text, ctx),
    );
  });

  it('cpcFallback: registry.parse === parseCpcFallback', () => {
    const text = 'G06F\nG06N\nH04L';
    assert.deepEqual(
      getPrompt('cpc-mapper', 'fallback').parse(text),
      parseCpcFallback(text),
    );
  });

  it('solutionDiscovery: registry.parse === parseSolutionDiscoveryResponse', () => {
    const text = 'sota_name=GitHub Actions\nsota_description=Modern CI\nlegacy_name=Jenkins\nlegacy_description=Legacy CI\nconfidence=0.88\nreasoning=classic pairing';
    assert.deepEqual(
      getPrompt('pipeline-enrichment', 'solution-discovery').parse(text, 'CI/CD'),
      parseSolutionDiscoveryResponse(text, 'CI/CD'),
    );
  });

  it('webSearchVerification: registry.parse === parseWebSearchResponse', () => {
    const text = 'classification=solution\nconfidence=0.92\nreasoning=named product';
    assert.deepEqual(
      getPrompt('web-search-verification').parse(text, 'Kubernetes'),
      parseWebSearchResponse(text, 'Kubernetes'),
    );
  });

  it('solutionClassification: registry.parse === parseLLMClassificationResponse', () => {
    const text = 'classification=capability\nconfidence=0.7\nreasoning=generic activity';
    assert.deepEqual(
      getPrompt('solution-classification').parse(text, 'CRM'),
      parseLLMClassificationResponse(text, 'CRM'),
    );
  });

  it('cpcSotExtraction: registry.parse === parseCpcSotExtraction', () => {
    const text = 'Amazon EKS | Managed Kubernetes service on AWS | 0.82';
    assert.deepEqual(
      getPrompt('cpc-evolution', 'sot-extraction').parse(text),
      parseCpcSotExtraction(text),
    );
    // Malformed line returns null
    assert.deepEqual(
      getPrompt('cpc-evolution', 'sot-extraction').parse('no pipes here'),
      parseCpcSotExtraction('no pipes here'),
    );
  });
});
