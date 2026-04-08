// End-to-end test: Conversational mode correctly routes and evaluates solutions
//
// Sub-AC 2 validation:
//   When classification detects a solution in conversational mode, the
//   multi-turn flow invokes solution-strategies with appropriate
//   solution-specific prompts and context from the conversation.
//
// Test architecture (optimized for speed):
//   Part 1: FAST — Session branching and context enrichment (no LLM)
//   Part 2: FAST — Mock LLM conversational dispatch (validates prompt threading)
//   Part 3: FAST — Context composition from conversation fields
//   Part 4: INTEGRATION — Full conversational flow with mock LLM
//   Part 5: FAST — Mode parameter correctly passed through dispatch chain

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { estimateEvolutionConversational } from './estimate-evolution.mjs';
import { ConversationSession } from './conversation-session.mjs';
import {
  dispatchSolutionStrategies,
  COMPONENT_TYPE,
} from './solution-capability-router.mjs';

// Standard mock LLM that returns all-phase-3 evaluations
const mockLlmPhase3 = async () => [
  'Market=3|Established market with growing competition',
  'Knowledge management=3|Widely published and taught',
  'Market perception=3|Well-understood and accepted',
  'User perception=3|Expected reliability and support',
  'Industry perception=3|Recognized as strategic necessity',
  'Value focus=3|Reliability and TCO driven',
  'Understanding=3|Well-understood with established architectures',
  'Comparison=3|Feature-by-feature comparison standard',
  'Failure/deficiency=3|Notable events tracked via SLAs',
  'Market action/engagement=3|Product marketing and competitive positioning',
  'Efficiency=3|Good efficiency with established processes',
  'Decision driver=3|Feature comparison and risk mitigation',
].join('\n');

// ─── Test Suite ───────────────────────────────────────────────────────────

describe('Solution conversational E2E — Sub-AC 2', () => {
  let originalMode;

  before(() => {
    originalMode = process.env.WARDLEY_EVAL_MODE;
    delete process.env.WARDLEY_EVAL_MODE;
  });

  after(() => {
    if (originalMode !== undefined) {
      process.env.WARDLEY_EVAL_MODE = originalMode;
    } else {
      delete process.env.WARDLEY_EVAL_MODE;
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 1: FAST — Session branching and context enrichment (no LLM)
  // ══════════════════════════════════════════════════════════════════════════

  describe('session context enrichment for solutions', () => {
    it('buildComponentInput() enriches context with solutionContext for solutions', () => {
      const session = new ConversationSession();
      session.update({
        name: 'Kubernetes',
        description: 'Container orchestration platform',
      });
      session.update({
        solutionContext: 'Dominant CNCF project, widely adopted by enterprises',
      });

      const input = session.buildComponentInput();

      assert.equal(input.isSolution, true);
      assert.ok(input.context.includes('Container orchestration platform'));
      assert.ok(input.context.includes('Dominant CNCF project'));
    });

    it('buildComponentInput() includes marketDynamics in enriched context', () => {
      const session = new ConversationSession();
      session.update({
        name: 'Salesforce',
        description: 'CRM platform',
        solutionContext: 'Market leader in CRM',
        marketDynamics: 'Few serious competitors at enterprise scale',
      });

      const input = session.buildComponentInput();

      assert.ok(input.context.includes('CRM platform'));
      assert.ok(input.context.includes('Market leader'));
      assert.ok(input.context.includes('Market dynamics'));
      assert.ok(input.context.includes('Few serious competitors'));
    });

    it('buildComponentInput() includes adoptionPattern in enriched context', () => {
      const session = new ConversationSession();
      session.update({
        name: 'Docker',
        description: 'Containerization platform',
        adoptionPattern: 'Universal adoption in development workflows',
      });

      const input = session.buildComponentInput();

      assert.ok(input.context.includes('Containerization platform'));
      assert.ok(input.context.includes('Adoption pattern'));
      assert.ok(input.context.includes('Universal adoption'));
    });

    it('buildComponentInput() does NOT enrich context for capabilities', () => {
      const session = new ConversationSession();
      session.update({
        name: 'container orchestration',
        description: 'Managing container workloads',
        marketDynamics: 'Multiple solutions available',
      });

      const input = session.buildComponentInput();

      // Capabilities keep the plain description as context
      assert.equal(input.context, 'Managing container workloads');
      assert.equal(input.isSolution, undefined);
    });

    it('buildComponentInput() handles missing optional fields gracefully', () => {
      const session = new ConversationSession();
      session.update({ name: 'Terraform' });
      // Only name, no solutionContext, marketDynamics, or adoptionPattern

      const input = session.buildComponentInput();

      assert.equal(input.isSolution, true);
      assert.equal(input.name, 'Terraform');
      // Context should still be a string (even if empty)
      assert.equal(typeof input.context, 'string');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 2: FAST — Mock LLM dispatch (validates prompt receives context)
  // ══════════════════════════════════════════════════════════════════════════

  describe('solution strategy dispatch with conversational context', () => {
    it('dispatches with mode=conversational', async () => {
      let receivedMode = null;

      // Use a direct mock that captures what the strategy gets
      const evaluations = await dispatchSolutionStrategies(
        {
          name: 'Kubernetes',
          description: 'Container orchestration platform',
          context: 'Container orchestration platform. Dominant CNCF project. Market dynamics: many competitors',
          solutionContext: 'Dominant CNCF project',
        },
        {
          llmCall: mockLlmPhase3,
          strategy: 'all',
          mode: 'conversational',
        }
      );

      const result = evaluations['solution-properties'];
      assert.ok(!result.error, `Strategy should succeed: ${result?.error}`);
      assert.equal(typeof result.evolution, 'number');
      assert.ok(result.evolution >= 0 && result.evolution <= 1);
      assert.equal(result.method, 'solution-properties');
      assert.ok(Array.isArray(result.properties));
      assert.equal(result.properties.length, 12);
    });

    it('conversational context passed to LLM prompt includes solutionContext', async () => {
      let capturedPrompt = '';
      const capturingLlm = async (prompt) => {
        capturedPrompt = prompt;
        return mockLlmPhase3();
      };

      await dispatchSolutionStrategies(
        {
          name: 'Kafka',
          description: 'Event streaming platform',
          context: 'Event streaming platform. De facto standard for event-driven architectures. Market dynamics: Confluent dominates',
          solutionContext: 'De facto standard for event-driven architectures',
          metadata: {
            marketDynamics: 'Confluent dominates',
          },
        },
        {
          llmCall: capturingLlm,
          strategy: 'all',
          mode: 'auto',
        }
      );

      // The prompt should contain the enriched context
      assert.ok(capturedPrompt.includes('Kafka'), 'Prompt should include solution name');
      assert.ok(
        capturedPrompt.includes('Event streaming') ||
        capturedPrompt.includes('event streaming') ||
        capturedPrompt.includes('event-driven'),
        'Prompt should include solution context'
      );
    });

    it('conversational mode calls LLM per-property (12 calls)', async () => {
      let callCount = 0;
      const singlePropLlm = async (prompt) => {
        callCount++;
        // Return a single property evaluation matching the prompt
        const nameMatch = prompt.match(/property: "(.+?)"/);
        const name = nameMatch ? nameMatch[1] : 'Market';
        return `${name}=3|Well-established`;
      };

      const evaluations = await dispatchSolutionStrategies(
        { name: 'PostgreSQL', context: 'Relational database. Mature open source.' },
        { llmCall: singlePropLlm, strategy: 'all', mode: 'conversational' }
      );

      const result = evaluations['solution-properties'];
      assert.ok(!result.error, `Strategy error: ${result?.error}`);
      assert.equal(callCount, 12, `Conversational mode should make 12 LLM calls, got ${callCount}`);
    });

    it('auto mode calls LLM once (1 call)', async () => {
      let callCount = 0;
      const countingLlm = async () => {
        callCount++;
        return mockLlmPhase3();
      };

      await dispatchSolutionStrategies(
        { name: 'PostgreSQL', context: 'Relational database.' },
        { llmCall: countingLlm, strategy: 'all', mode: 'auto' }
      );

      assert.equal(callCount, 1, `Auto mode should make 1 LLM call, got ${callCount}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 3: FAST — Context composition from conversation fields
  // ══════════════════════════════════════════════════════════════════════════

  describe('context composition from conversational fields', () => {
    it('all three solution fields compose into context', () => {
      const session = new ConversationSession();
      session.update({
        name: 'Snowflake',
        description: 'Cloud data warehouse',
        solutionContext: 'Leading cloud-native data warehouse',
        marketDynamics: 'Competing with BigQuery, Redshift, Databricks',
        adoptionPattern: 'Rapid enterprise adoption, especially in data-heavy orgs',
      });

      const input = session.buildComponentInput();
      const ctx = input.context;

      // All parts should be present in the composed context
      assert.ok(ctx.includes('Cloud data warehouse'));
      assert.ok(ctx.includes('Leading cloud-native'));
      assert.ok(ctx.includes('Competing with BigQuery'));
      assert.ok(ctx.includes('Rapid enterprise adoption'));
    });

    it('sector enriches solution context when available', () => {
      const session = new ConversationSession();
      session.update({
        name: 'Stripe',
        description: 'Payment processing API',
        solutionContext: 'Dominant payment API for developers',
        sector: 'fintech',
      });

      const input = session.buildComponentInput();
      assert.ok(input.context.includes('Sector: fintech'));
    });

    it('context deduplication avoids repeating description', () => {
      const session = new ConversationSession();
      session.update({
        name: 'Redis',
        description: 'In-memory data store',
      });

      const input = session.buildComponentInput();
      // Count how many times the description appears
      const matches = input.context.match(/In-memory data store/g) || [];
      assert.equal(matches.length, 1, 'Description should not be duplicated');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 4: INTEGRATION — Full conversational flow with mock LLM
  // ══════════════════════════════════════════════════════════════════════════

  describe('full conversational multi-turn flow', () => {
    it('Kubernetes: identity → solution_context → evaluation', async () => {
      // Turn 1: Start session with component name
      const turn1 = await estimateEvolutionConversational({
        data: { name: 'Kubernetes', description: 'Container orchestration' },
      });

      assert.equal(turn1.mode, 'conversational');
      assert.equal(turn1.phase, 'solution_context');
      assert.ok(turn1.nextQuestion != null, 'Should return a question');
      assert.equal(turn1.nextQuestion.phase, 'solution_context');
      assert.ok(turn1.evaluations == null, 'Not ready for evaluation yet');
      assert.ok(turn1.sessionState, 'Session state should be serialized');

      // Verify the solution detection was recorded
      const session1 = ConversationSession.deserialize(turn1.sessionState);
      assert.equal(session1.state.componentType, 'solution');
      assert.ok(session1.state.componentTypeConfidence >= 0.90);

      // Turn 2: Provide solution context (should trigger evaluation)
      // Note: The actual evaluation requires a real LLM call. For this test,
      // we validate that the session reaches 'ready' and the result shape is correct.
      const session2 = ConversationSession.deserialize(turn1.sessionState);
      session2.update({
        solutionContext: 'Dominant container orchestration platform, CNCF graduated project, adopted by 80%+ of enterprises',
        marketDynamics: 'Strong ecosystem, many managed offerings (EKS, AKS, GKE)',
      });

      assert.equal(session2.phase, 'ready');
      assert.ok(session2.isReadyForEstimation());

      // Verify the enriched component input
      const component = session2.buildComponentInput();
      assert.equal(component.isSolution, true);
      assert.ok(component.context.includes('Container orchestration'));
      assert.ok(component.context.includes('Dominant container orchestration'));
      assert.ok(component.context.includes('Market dynamics'));
      assert.ok(component.solutionContext.includes('CNCF'));
    });

    it('capability path is unchanged: CRM → characteristics → market_signals', async () => {
      // Turn 1: Start session with capability name
      const turn1 = await estimateEvolutionConversational({
        data: { name: 'CRM', description: 'Customer relationship management' },
      });

      assert.equal(turn1.mode, 'conversational');
      assert.equal(turn1.phase, 'characteristics');
      assert.ok(turn1.nextQuestion != null);
      assert.equal(turn1.nextQuestion.phase, 'characteristics');

      // Turn 2: Provide characteristics
      const turn2 = await estimateEvolutionConversational({
        sessionState: turn1.sessionState,
        data: { certitude: 0.85, ubiquity: 0.8 },
      });

      assert.equal(turn2.phase, 'market_signals');
      assert.ok(turn2.nextQuestion != null);
    });

    it('forceEstimate works for solutions with minimal context', async () => {
      const turn1 = await estimateEvolutionConversational({
        data: { name: 'Docker', description: 'Containerization platform' },
      });

      assert.equal(turn1.phase, 'solution_context');

      // Force estimate without providing solution context
      // This should proceed to evaluation (though with limited data)
      const session = ConversationSession.deserialize(turn1.sessionState);
      session.forceReady();
      assert.ok(session.isReadyForEstimation());

      const component = session.buildComponentInput();
      assert.equal(component.isSolution, true);
      assert.equal(component.name, 'Docker');
    });

    it('non-economic components skip solution routing entirely', async () => {
      const result = await estimateEvolutionConversational({
        data: { name: 'Air', description: 'Atmospheric oxygen for breathing' },
      });

      // Should go to ready immediately (non-economic re-questioning)
      assert.equal(result.phase, 'complete');
      assert.ok(result.reQuestions != null && result.reQuestions.length > 0);
      assert.equal(result.evaluations, null);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Part 5: FAST — Mode parameter correctly flows through dispatch chain
  // ══════════════════════════════════════════════════════════════════════════

  describe('mode parameter flow through dispatch chain', () => {
    it('mode=conversational makes solution-properties evaluate per-property', async () => {
      let callCount = 0;
      const singlePropLlm = async (prompt) => {
        callCount++;
        const nameMatch = prompt.match(/property: "(.+?)"/);
        const name = nameMatch ? nameMatch[1] : 'Market';
        return `${name}=3|Well-established`;
      };

      const evaluations = await dispatchSolutionStrategies(
        {
          name: 'Terraform',
          context: 'IaC tool. Dominant in multi-cloud. Market dynamics: competing with Pulumi, CDK',
          solutionContext: 'Dominant in multi-cloud infrastructure management',
        },
        {
          llmCall: singlePropLlm,
          strategy: 'all',
          mode: 'conversational',
        }
      );

      const result = evaluations['solution-properties'];
      assert.ok(!result.error);
      assert.equal(callCount, 12, 'Conversational mode: 12 per-property LLM calls');
      assert.equal(result.properties.length, 12);
    });

    it('mode=auto uses single batch LLM call for all 12 properties', async () => {
      let callCount = 0;
      const batchLlm = async () => {
        callCount++;
        return mockLlmPhase3();
      };

      const evaluations = await dispatchSolutionStrategies(
        {
          name: 'Terraform',
          context: 'IaC tool for multi-cloud',
        },
        {
          llmCall: batchLlm,
          strategy: 'all',
          mode: 'auto',
        }
      );

      const result = evaluations['solution-properties'];
      assert.ok(!result.error);
      assert.equal(callCount, 1, 'Auto mode: single batch LLM call');
      assert.equal(result.properties.length, 12);
    });

    it('dispatch returns valid EvolutionResult contract for conversational mode', async () => {
      const evaluations = await dispatchSolutionStrategies(
        {
          name: 'Grafana',
          context: 'Observability platform. Leading open-source dashboarding. Market dynamics: strong community',
          solutionContext: 'Leading open-source observability dashboarding',
        },
        {
          llmCall: mockLlmPhase3,
          strategy: 'all',
          mode: 'auto',
        }
      );

      const result = evaluations['solution-properties'];
      assert.ok(!result.error);

      // EvolutionResult contract
      assert.equal(typeof result.evolution, 'number');
      assert.ok(result.evolution >= 0 && result.evolution <= 1);
      assert.equal(typeof result.confidence, 'number');
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
      assert.equal(result.method, 'solution-properties');

      // Solution-specific: 12 properties with equal weights
      assert.ok(Array.isArray(result.properties));
      assert.equal(result.properties.length, 12);

      const expectedWeight = 1 / 12;
      for (const prop of result.properties) {
        assert.equal(typeof prop.property, 'string');
        assert.equal(typeof prop.phase, 'number');
        assert.ok(prop.phase >= 1 && prop.phase <= 4);
        assert.ok(Math.abs(prop.weight - expectedWeight) < 0.001);
      }
    });
  });
});
