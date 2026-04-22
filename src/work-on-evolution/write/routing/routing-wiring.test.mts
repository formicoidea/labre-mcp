// AC 5020202: Verify orchestrator's routing metadata flows through mode-router
// into downstream consumers (MCP tool, skill handler) and response formatter.
//
// Tests that the solution/capability determination and confidence score
// from estimate-evolution.mjs feed into the RoutedResponse and formatted output.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { routeEstimateEvolution, detectMode, MODES } from './mode-router.mjs';
import { formatResponse, formatStrategyResult, evolutionToStage, strategyReasoning } from '../../../lib/response-formatter.mjs';

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('AC 5020202: Routing wiring through mode-router and response-formatter', () => {

  // ── 1. Mode router passes routing metadata through (one-shot) ──────────

  it('routeEstimateEvolution one-shot includes routing metadata for known capability', async () => {
    // ERP is a known capability — should route to capability strategies only
    const result = await routeEstimateEvolution({
      name: 'ERP',
      description: 'Enterprise resource planning',
      space: 'economic',
      strategy: 'write:capacity:s-curve',
      certitude: 0.9,
      ubiquity: 0.85,
    });

    // Verify routing metadata is present
    assert.ok(result.routing, 'routing metadata must be present in RoutedResponse');
    assert.equal(result.routing.type, 'capability', 'ERP should be detected as capability');
    assert.ok(result.routing.confidence >= 0.90, `confidence should be >= 0.90, got ${result.routing.confidence}`);
    assert.equal(typeof result.routing.method, 'string', 'method must be a string');
    assert.equal(result.routing.evalMode, 'exclusive', 'default mode should be exclusive');
    assert.equal(result.routing.usedCapabilityStrategies, true, 'capability strategies should be used');
    assert.equal(result.routing.usedSolutionStrategies, false, 'solution strategies should NOT be used for capability');
  });

  it('routeEstimateEvolution one-shot includes routing metadata for known solution', async () => {
    // Kubernetes is a known solution — should route to solution strategies
    const result = await routeEstimateEvolution({
      name: 'Kubernetes',
      description: 'Container orchestration platform',
      space: 'economic',
      strategy: 'all',
    });

    assert.ok(result.routing, 'routing metadata must be present');
    assert.equal(result.routing.type, 'solution', 'Kubernetes should be detected as solution');
    assert.ok(result.routing.confidence >= 0.90, `confidence should be >= 0.90, got ${result.routing.confidence}`);
    assert.equal(result.routing.usedSolutionStrategies, true, 'solution strategies should be used');
    assert.equal(result.routing.usedCapabilityStrategies, false, 'capability strategies should NOT be used for solution in exclusive mode');
    assert.equal(result.routing.evalMode, 'exclusive', 'default mode is exclusive');
  });

  it('routing is null for non-economic components (social_good)', async () => {
    const result = await routeEstimateEvolution({
      name: 'Air',
      description: 'Atmospheric oxygen',
      space: 'social_good',
    });

    // Non-economic components don't go through routing
    // (they hit the re-questioning path before routing occurs)
    assert.equal(result.evaluations, null, 'evaluations null for non-economic');
    assert.ok(result.reQuestions && result.reQuestions.length > 0, 'reQuestions should be present');
    // routing may or may not be null — depends on whether the orchestrator sets it before the gate
  });

  // ── 2. Mode router passes routing through (guided) ───────────────────

  it('routeEstimateEvolution guided includes routing metadata on completion', async () => {
    // First turn: start conversation
    const turn1 = await routeEstimateEvolution({
      name: 'Docker',
      description: 'Container runtime platform',
    });

    assert.equal(turn1.mode, 'guided', 'should detect guided mode');
    assert.ok(turn1.sessionState, 'should have session state');
    // Routing may not be set yet on intermediate turns (evaluation hasn't happened)

    // Force estimation on second turn
    const turn2 = await routeEstimateEvolution({
      sessionState: turn1.sessionState,
      forceEstimate: true,
    });

    // When estimation completes, routing should be present
    if (turn2.evaluations) {
      assert.ok(turn2.routing, 'routing metadata must be present on completed guided estimation');
      assert.equal(typeof turn2.routing.type, 'string', 'routing.type must be string');
      assert.equal(typeof turn2.routing.confidence, 'number', 'routing.confidence must be number');
      assert.ok(
        turn2.routing.usedSolutionStrategies || turn2.routing.usedCapabilityStrategies,
        'at least one strategy pipeline must have been dispatched'
      );
    }
  });

  // ── 3. Response formatter includes routing in formatted output ────────

  it('formatResponse includes routing info for solution component', () => {
    const mockResult = {
      mode: 'oneshot',
      classification: { space: 'economic', reason: 'Market component', requiresReQuestion: false },
      reQuestions: null,
      evaluations: {
        'properties': {
          evolution: 0.62,
          confidence: 0.85,
          method: 'properties',
          properties: [
            { property: 'Market', phase: 3, reason: 'Established market' },
            { property: 'Knowledge management', phase: 3, reason: 'Well documented' },
          ],
        },
      },
      routing: {
        type: 'solution',
        confidence: 0.98,
        method: 'known-solution',
        evalMode: 'exclusive',
        usedSolutionStrategies: true,
        usedCapabilityStrategies: false,
      },
      message: 'Test message',
    };

    const formatted = formatResponse(mockResult, {
      component: { name: 'Kubernetes' },
    });

    // Verify routing section appears in formatted output
    assert.ok(formatted.includes('Named Solution'), 'should show "Named Solution" label');
    assert.ok(formatted.includes('98%'), 'should show 98% confidence');
    assert.ok(formatted.includes('dictionary match'), 'should show detection method');
    assert.ok(formatted.includes('solution (12-property evaluation)'), 'should show solution pipeline');
    assert.ok(formatted.includes('exclusive'), 'should show eval mode');
  });

  it('formatResponse includes routing info for capability component', () => {
    const mockResult = {
      mode: 'oneshot',
      classification: { space: 'economic', reason: 'Market component', requiresReQuestion: false },
      reQuestions: null,
      evaluations: {
        'write:capacity:s-curve': { evolution: 0.75, confidence: 0.60, method: 'write:capacity:s-curve' },
      },
      routing: {
        type: 'capability',
        confidence: 0.97,
        method: 'known-capability',
        evalMode: 'exclusive',
        usedSolutionStrategies: false,
        usedCapabilityStrategies: true,
      },
      message: 'Test message',
    };

    const formatted = formatResponse(mockResult, {
      component: { name: 'CRM', certitude: 0.9, ubiquity: 0.85 },
    });

    assert.ok(formatted.includes('Abstract Capability'), 'should show "Abstract Capability" label');
    assert.ok(formatted.includes('97%'), 'should show 97% confidence');
    assert.ok(formatted.includes('dictionary match (known capability)'), 'should show detection method');
    assert.ok(formatted.includes('capability'), 'should mention capability pipeline');
  });

  it('formatResponse skips routing section in compact mode', () => {
    const mockResult = {
      mode: 'oneshot',
      classification: { space: 'economic', reason: 'Market', requiresReQuestion: false },
      reQuestions: null,
      evaluations: {
        'write:capacity:s-curve': { evolution: 0.75, confidence: 0.60, method: 'write:capacity:s-curve' },
      },
      routing: {
        type: 'capability',
        confidence: 0.97,
        method: 'known-capability',
        evalMode: 'exclusive',
        usedSolutionStrategies: false,
        usedCapabilityStrategies: true,
      },
      message: 'Test',
    };

    const formatted = formatResponse(mockResult, {
      component: { name: 'CRM' },
      compact: true,
    });

    // Compact mode should NOT show routing details
    assert.ok(!formatted.includes('Component Type:'), 'compact mode should skip routing block');
  });

  it('formatResponse handles missing routing gracefully', () => {
    const mockResult = {
      mode: 'oneshot',
      classification: { space: 'economic', reason: 'Market', requiresReQuestion: false },
      reQuestions: null,
      evaluations: {
        'write:capacity:s-curve': { evolution: 0.75, confidence: 0.60, method: 'write:capacity:s-curve' },
      },
      message: 'Test',
    };

    // No routing field — should not crash
    const formatted = formatResponse(mockResult, {
      component: { name: 'Something' },
    });

    assert.ok(typeof formatted === 'string', 'should produce valid output');
    assert.ok(!formatted.includes('Component Type:'), 'should not show routing when absent');
  });

  // ── 4. Strategy reasoning for solution strategies ─────────────────────

  it('strategyReasoning provides reasoning for properties strategy', () => {
    const result = {
      evolution: 0.62,
      confidence: 0.85,
      method: 'properties',
      properties: [
        { property: 'Market', phase: 3 },
        { property: 'Knowledge management', phase: 3 },
      ],
    };

    const reasoning = strategyReasoning('properties', result, { name: 'Kubernetes' });

    assert.ok(reasoning.includes('12-property'), 'should mention 12-property evaluation');
    assert.ok(reasoning.includes('Product'), 'should mention the Product stage');
  });

  it('formatStrategyResult includes property breakdown for solution results', () => {
    const result = {
      evolution: 0.55,
      confidence: 0.80,
      method: 'properties',
      properties: [
        { property: 'Market', phase: 3, reason: 'Established market' },
        { property: 'Knowledge management', phase: 2, reason: 'Emerging knowledge' },
        { property: 'Efficiency', phase: 4, reason: 'Highly efficient' },
      ],
    };

    const formatted = formatStrategyResult('properties', result, { name: 'Kubernetes' });

    assert.ok(formatted.includes('Property breakdown'), 'should show property breakdown section');
    assert.ok(formatted.includes('Market: **Product**'), 'should show Market as Product');
    assert.ok(formatted.includes('Knowledge management: **Custom**'), 'should show Knowledge as Custom');
    assert.ok(formatted.includes('Efficiency: **Commodity**'), 'should show Efficiency as Commodity');
  });

  // ── 5. Routing metadata includes verification info when available ─────

  it('formatResponse shows verification status when dual-verification was used', () => {
    const mockResult = {
      mode: 'oneshot',
      classification: { space: 'economic', reason: 'Market', requiresReQuestion: false },
      reQuestions: null,
      evaluations: {
        'properties': { evolution: 0.62, confidence: 0.85, method: 'properties' },
      },
      routing: {
        type: 'solution',
        confidence: 0.92,
        method: 'naming+llm',
        evalMode: 'exclusive',
        usedSolutionStrategies: true,
        usedCapabilityStrategies: false,
        verified: true,
        tiersUsed: ['naming', 'llm'],
      },
      message: 'Test',
    };

    const formatted = formatResponse(mockResult, {
      component: { name: 'MyCustomPlatform' },
    });

    assert.ok(formatted.includes('Verification:'), 'should show verification line');
    assert.ok(formatted.includes('confirmed'), 'should show confirmed status');
    assert.ok(formatted.includes('naming'), 'should show tiers used');
  });

  // ── 6. detectMode is unaffected ──────────────────────────────────────

  it('detectMode continues to work unchanged', () => {
    const r1 = detectMode({ mode: 'oneshot' });
    assert.equal(r1.mode, MODES.ONESHOT);

    const r2 = detectMode({ mode: 'guided' });
    assert.equal(r2.mode, MODES.GUIDED);

    const r3 = detectMode({ name: 'ERP', certitude: 0.9, ubiquity: 0.85 });
    assert.equal(r3.mode, MODES.ONESHOT);

    const r4 = detectMode({ name: 'ERP' });
    assert.equal(r4.mode, MODES.GUIDED);

    const r5 = detectMode({ sessionState: 'some-state' });
    assert.equal(r5.mode, MODES.GUIDED);
  });
});
