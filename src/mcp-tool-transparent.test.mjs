// AC 12: estimateEvolution MCP tool works transparently with both solutions and capabilities
//
// Validates that the MCP tool layer (handleEstimateEvolution) produces consistent,
// well-formed responses for both solutions and capabilities.
//
// Structure:
//   Group A: FAST tests — pure detection, schema, routing (no LLM, <1s)
//   Group B: INTEGRATION — one capability MCP call (s-curve, no LLM ~1s)
//   Group C: INTEGRATION — one solution MCP call (may use LLM ~30-60s)
//   Group D: FAST — guided mode first turns (session creation, no strategy evaluation)

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleEstimateEvolution, ESTIMATE_EVOLUTION_TOOL } from './mcp-tool.mjs';
import { handleRequest, REGISTERED_TOOLS, TOOL_HANDLERS } from './mcp-server.mjs';
import { routeEstimateEvolution } from './mode-router.mjs';
import {
  detectComponentType,
  determineRoutingTargets,
  COMPONENT_TYPE,
  EVAL_MODES,
} from './solution-capability-router.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────

const REQUIRED_ROUTED_FIELDS = [
  'mode', 'modeReason', 'classification', 'reQuestions',
  'evaluations', 'message', 'formatted', 'sessionState',
  'nextQuestion', 'phase', 'routing',
];

function assertRoutedResponseShape(result, label = '') {
  for (const field of REQUIRED_ROUTED_FIELDS) {
    assert.ok(field in result, `${label}: missing "${field}" in RoutedResponse`);
  }
}

function assertRoutingMetadataShape(routing, label = '') {
  assert.ok(routing, `${label}: routing metadata must be present`);
  assert.ok(['solution', 'capability'].includes(routing.type), `${label}: type must be solution|capability`);
  assert.equal(typeof routing.confidence, 'number', `${label}: confidence must be number`);
  assert.ok(routing.confidence >= 0 && routing.confidence <= 1);
  assert.equal(typeof routing.method, 'string');
  assert.ok(['exclusive', 'parallel'].includes(routing.evalMode));
  assert.equal(typeof routing.usedSolutionStrategies, 'boolean');
  assert.equal(typeof routing.usedCapabilityStrategies, 'boolean');
}

// ─── Test Suite ──────────────────────────────────────────────────────────

describe('AC 12: MCP tool transparent solution + capability support', () => {
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

  // ═════════════════════════════════════════════════════════════════════
  // Group A: FAST — Schema, detection, routing (no LLM, <1ms each)
  // ═════════════════════════════════════════════════════════════════════

  describe('A1: Tool schema covers both solution and capability paths', () => {
    it('has valid estimateEvolution schema', () => {
      assert.equal(ESTIMATE_EVOLUTION_TOOL.name, 'estimateEvolution');
      assert.ok(ESTIMATE_EVOLUTION_TOOL.inputSchema);
      assert.equal(ESTIMATE_EVOLUTION_TOOL.inputSchema.type, 'object');
      assert.ok(ESTIMATE_EVOLUTION_TOOL.inputSchema.properties.name);
      assert.deepEqual(ESTIMATE_EVOLUTION_TOOL.inputSchema.required, ['name']);
    });

    it('description mentions solutions, capabilities, 12 properties, and routing', () => {
      const desc = ESTIMATE_EVOLUTION_TOOL.description;
      assert.ok(desc.includes('solution'), 'should mention solutions');
      assert.ok(desc.includes('capabilit'), 'should mention capabilities');
      assert.ok(desc.includes('12'), 'should mention 12 properties');
      assert.ok(desc.includes('routing') || desc.includes('Routing'), 'should mention routing');
    });

    it('mode enum includes all supported modes', () => {
      const modeEnum = ESTIMATE_EVOLUTION_TOOL.inputSchema.properties.mode.enum;
      assert.ok(modeEnum.includes('oneshot'));
      assert.ok(modeEnum.includes('guided'));
      assert.ok(modeEnum.includes('conversational'));
      assert.ok(modeEnum.includes('auto'));
    });

    it('tool is registered in MCP server', () => {
      assert.ok(REGISTERED_TOOLS.some(t => t.name === 'estimateEvolution'));
      assert.ok(TOOL_HANDLERS.has('estimateEvolution'));
      assert.equal(typeof TOOL_HANDLERS.get('estimateEvolution'), 'function');
    });
  });

  describe('A2: Detection accuracy — solutions detected correctly', () => {
    const solutions = [
      'Kubernetes', 'Docker', 'Salesforce', 'SAP', 'AWS', 'PostgreSQL',
      'Redis', 'Kafka', 'Terraform', 'Jenkins', 'Stripe', 'Shopify',
      'Datadog', 'Grafana', 'Prometheus', 'Slack', 'Jira', 'Snowflake',
      'MongoDB', 'Elasticsearch', 'GitHub Actions', 'GitLab',
    ];

    for (const name of solutions) {
      it(`${name} → solution ≥90% confidence`, () => {
        const d = detectComponentType(name);
        assert.equal(d.type, COMPONENT_TYPE.SOLUTION, `${name} should be solution`);
        assert.ok(d.confidence >= 0.90, `${name}: ${d.confidence} < 0.90`);
        assert.equal(d.needsFallback, false);
      });
    }
  });

  describe('A3: Detection accuracy — capabilities detected correctly', () => {
    const capabilities = [
      'CRM', 'ERP', 'DevOps', 'CI/CD', 'container orchestration',
      'payment processing', 'monitoring', 'data analytics',
      'identity management', 'load balancing', 'event streaming',
      'authentication', 'machine learning', 'LLM',
    ];

    for (const name of capabilities) {
      it(`${name} → capability ≥85% confidence`, () => {
        const d = detectComponentType(name);
        assert.equal(d.type, COMPONENT_TYPE.CAPABILITY, `${name} should be capability`);
        assert.ok(d.confidence >= 0.85, `${name}: ${d.confidence} < 0.85`);
      });
    }
  });

  describe('A4: Routing targets in exclusive vs parallel mode', () => {
    it('exclusive: solution → solution-strategies only', () => {
      const d = detectComponentType('Kubernetes');
      const t = determineRoutingTargets(d);
      assert.equal(t.useSolutionStrategies, true);
      assert.equal(t.useCapabilityStrategies, false);
      assert.equal(t.mode, 'exclusive');
    });

    it('exclusive: capability → capability strategies only', () => {
      const d = detectComponentType('CRM');
      const t = determineRoutingTargets(d);
      assert.equal(t.useSolutionStrategies, false);
      assert.equal(t.useCapabilityStrategies, true);
      assert.equal(t.mode, 'exclusive');
    });

    it('parallel: solution → both strategy sets', () => {
      process.env.WARDLEY_EVAL_MODE = 'parallel';
      try {
        const d = detectComponentType('Kafka');
        const t = determineRoutingTargets(d);
        assert.equal(t.useSolutionStrategies, true);
        assert.equal(t.useCapabilityStrategies, true);
        assert.equal(t.mode, 'parallel');
      } finally {
        delete process.env.WARDLEY_EVAL_MODE;
      }
    });

    it('parallel: capability → both strategy sets', () => {
      process.env.WARDLEY_EVAL_MODE = 'parallel';
      try {
        const d = detectComponentType('monitoring');
        const t = determineRoutingTargets(d);
        assert.equal(t.useSolutionStrategies, true);
        assert.equal(t.useCapabilityStrategies, true);
      } finally {
        delete process.env.WARDLEY_EVAL_MODE;
      }
    });
  });

  describe('A5: Error handling identical for both paths', () => {
    it('missing name rejects', async () => {
      await assert.rejects(() => handleEstimateEvolution({}), /non-empty string/);
      await assert.rejects(() => handleEstimateEvolution({ name: '' }), /non-empty string/);
    });

    it('invalid certitude rejected for solutions', async () => {
      await assert.rejects(
        () => handleEstimateEvolution({ name: 'Kubernetes', certitude: 2 }),
        /between 0 and 1/
      );
    });

    it('invalid certitude rejected for capabilities', async () => {
      await assert.rejects(
        () => handleEstimateEvolution({ name: 'CRM', certitude: -1 }),
        /between 0 and 1/
      );
    });

    it('MCP server wraps errors identically', async () => {
      const resp = await handleRequest({
        jsonrpc: '2.0',
        id: 'err-1',
        method: 'tools/call',
        params: { name: 'estimateEvolution', arguments: { name: '' } },
      });
      assert.equal(resp.jsonrpc, '2.0');
      assert.ok(resp.result.isError);
      const parsed = JSON.parse(resp.result.content[0].text);
      assert.ok(parsed.error);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Group B: INTEGRATION — capability MCP call (s-curve, fast)
  // ═════════════════════════════════════════════════════════════════════

  describe('B1: Capability via MCP tool — full pipeline', () => {
    it('ERP with s-curve returns valid RoutedResponse', async () => {
      const result = await handleEstimateEvolution({
        name: 'ERP',
        context: 'Enterprise resource planning for corporations',
        space: 'economic',
        strategy: 's-curve',
        certitude: 0.9,
        ubiquity: 0.85,
      });

      assertRoutedResponseShape(result, 'ERP');
      assert.equal(result.mode, 'oneshot');
      assert.equal(result.classification.space, 'economic');
      assert.ok(result.evaluations, 'evaluations non-null');
      assert.equal(result.reQuestions, null);

      // s-curve result valid
      const sc = result.evaluations['s-curve'];
      assert.ok(sc, 's-curve must be present');
      assert.ok(!sc.error, 's-curve should not error');
      assert.equal(typeof sc.evolution, 'number');
      assert.ok(sc.evolution >= 0 && sc.evolution <= 1);
      assert.equal(typeof sc.confidence, 'number');
      assert.equal(sc.method, 's-curve');

      // Routing metadata
      assertRoutingMetadataShape(result.routing, 'ERP');
      assert.equal(result.routing.type, 'capability');
      assert.equal(result.routing.usedCapabilityStrategies, true);
      assert.equal(result.routing.usedSolutionStrategies, false);
      assert.equal(result.routing.evalMode, 'exclusive');
    });

    it('MCP server handleRequest wraps capability result correctly', async () => {
      const response = await handleRequest({
        jsonrpc: '2.0',
        id: 'cap-wrap',
        method: 'tools/call',
        params: {
          name: 'estimateEvolution',
          arguments: {
            name: 'DevOps',
            context: 'Development operations',
            space: 'economic',
            strategy: 's-curve',
            certitude: 0.75,
            ubiquity: 0.80,
          },
        },
      });

      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.id, 'cap-wrap');
      assert.ok(!response.result.isError);
      const parsed = JSON.parse(response.result.content[0].text);
      assert.equal(parsed.mode, 'oneshot');
      assert.ok(parsed.evaluations);
      assert.ok(parsed.routing);
      assert.equal(parsed.routing.type, 'capability');
    });

    it('non-economic component (Air) returns re-questions', async () => {
      const result = await handleEstimateEvolution({
        name: 'Air',
        context: 'Atmospheric oxygen',
        mode: 'oneshot',
      });

      assertRoutedResponseShape(result, 'Air');
      assert.equal(result.evaluations, null);
      assert.ok(result.reQuestions && result.reQuestions.length > 0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Group C: INTEGRATION — solution MCP call (may use LLM)
  // ═════════════════════════════════════════════════════════════════════

  describe('C1: Solution via MCP tool — full pipeline', () => {
    it('Kubernetes returns valid RoutedResponse with solution routing', async () => {
      const result = await handleEstimateEvolution({
        name: 'Kubernetes',
        context: 'Container orchestration platform',
        space: 'economic',
      });

      // Response shape must match capability shape exactly
      assertRoutedResponseShape(result, 'Kubernetes');
      assert.equal(result.mode, 'oneshot');
      assert.equal(result.classification.space, 'economic');
      assert.ok(result.evaluations !== null, 'evaluations object non-null');
      assert.equal(result.reQuestions, null);

      // Routing must indicate solution
      assertRoutingMetadataShape(result.routing, 'Kubernetes');
      assert.equal(result.routing.type, 'solution');
      assert.ok(result.routing.confidence >= 0.90);
      assert.equal(result.routing.usedSolutionStrategies, true);
      assert.equal(result.routing.usedCapabilityStrategies, false);

      // Evaluations: each entry is either valid result or error
      const entries = Object.entries(result.evaluations);
      assert.ok(entries.length > 0, 'at least one evaluation entry');
      for (const [method, ev] of entries) {
        if (ev.error) {
          assert.equal(typeof ev.error, 'string', `${method}: error is string`);
        } else {
          assert.equal(typeof ev.evolution, 'number');
          assert.equal(typeof ev.confidence, 'number');
          assert.equal(typeof ev.method, 'string');
        }
      }

      // Message mentions the component name
      assert.ok(result.message.includes('Kubernetes'));
    });

    it('MCP server wraps solution result with same JSON-RPC shape', async () => {
      const response = await handleRequest({
        jsonrpc: '2.0',
        id: 'sol-wrap',
        method: 'tools/call',
        params: {
          name: 'estimateEvolution',
          arguments: {
            name: 'Salesforce',
            context: 'CRM platform',
            space: 'economic',
          },
        },
      });

      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.id, 'sol-wrap');
      assert.ok(response.result.content);
      assert.equal(response.result.content[0].type, 'text');
      assert.ok(!response.result.isError);

      const parsed = JSON.parse(response.result.content[0].text);
      assert.equal(parsed.mode, 'oneshot');
      assert.ok(parsed.evaluations !== null);
      assert.ok(parsed.routing);
      assert.equal(parsed.routing.type, 'solution');
    });

    it('same API params work for both — routing is the only difference', async () => {
      const solResult = await handleEstimateEvolution({
        name: 'Terraform',
        context: 'IaC tool by HashiCorp',
        space: 'economic',
        certitude: 0.7,
        ubiquity: 0.8,
      });
      const capResult = await handleEstimateEvolution({
        name: 'infrastructure as code',
        context: 'Codifying infrastructure provisioning',
        space: 'economic',
        strategy: 's-curve',
        certitude: 0.7,
        ubiquity: 0.8,
      });

      // Both produce valid responses
      assertRoutedResponseShape(solResult, 'Terraform');
      assertRoutedResponseShape(capResult, 'IaC');
      assert.ok(solResult.evaluations !== null);
      assert.ok(capResult.evaluations !== null);

      // Routing reveals the different paths taken
      assert.equal(solResult.routing.type, 'solution');
      assert.equal(capResult.routing.type, 'capability');
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Group D: Guided mode — first turns only (session creation, fast)
  // ═════════════════════════════════════════════════════════════════════

  describe('D1: Guided mode first turns — solution and capability', () => {
    it('solution name in guided mode returns nextQuestion + sessionState', async () => {
      const result = await handleEstimateEvolution({
        name: 'Kubernetes',
        context: 'Container orchestration',
      });

      assert.equal(result.mode, 'guided');
      assert.ok(result.sessionState);
      assert.ok(result.nextQuestion);
      assert.ok(result.formatted);
      assert.equal(typeof result.formatted, 'string');
    });

    it('capability name in guided mode returns nextQuestion + sessionState', async () => {
      const result = await handleEstimateEvolution({
        name: 'data analytics',
      });

      assert.equal(result.mode, 'guided');
      assert.ok(result.sessionState);
      assert.ok(result.nextQuestion);
    });

    it('guided first turns have identical RoutedResponse shape', async () => {
      const sol = await handleEstimateEvolution({ name: 'Salesforce' });
      const cap = await handleEstimateEvolution({ name: 'container orchestration' });

      assertRoutedResponseShape(sol, 'Salesforce guided');
      assertRoutedResponseShape(cap, 'container-orch guided');
      assert.equal(sol.mode, 'guided');
      assert.equal(cap.mode, 'guided');
      assert.ok(sol.sessionState);
      assert.ok(cap.sessionState);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Group E: Parallel mode via WARDLEY_EVAL_MODE env var (integration)
  // ═════════════════════════════════════════════════════════════════════

  describe('E1: Parallel mode routes to both pipelines', () => {
    let saved;

    beforeEach(() => {
      saved = process.env.WARDLEY_EVAL_MODE;
      process.env.WARDLEY_EVAL_MODE = 'parallel';
    });

    afterEach(() => {
      if (saved !== undefined) {
        process.env.WARDLEY_EVAL_MODE = saved;
      } else {
        delete process.env.WARDLEY_EVAL_MODE;
      }
    });

    it('parallel solution routes to both strategy sets', async () => {
      const result = await handleEstimateEvolution({
        name: 'Redis',
        context: 'In-memory data store',
        space: 'economic',
        certitude: 0.8,
        ubiquity: 0.85,
      });

      assertRoutedResponseShape(result, 'Redis parallel');
      assert.ok(result.routing);
      assert.equal(result.routing.evalMode, 'parallel');
      assert.equal(result.routing.usedSolutionStrategies, true);
      assert.equal(result.routing.usedCapabilityStrategies, true);
    });
  });
});
