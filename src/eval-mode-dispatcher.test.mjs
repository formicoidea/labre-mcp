// Tests for eval-mode-dispatcher.mjs
//
// Validates AC 8: WARDLEY_EVAL_MODE=exclusive (default) routes to one set only;
// parallel routes to both.
//
// Test categories:
//   1. Exclusive mode (default): solution → solution-strategies only
//   2. Exclusive mode: capability → capability strategies only
//   3. Parallel mode: always both strategy sets
//   4. Env var handling: default, explicit, unrecognized values
//   5. Result shape and namespacing in parallel mode
//   6. Preview dispatch (dry-run)
//   7. Backward compatibility: capability pipeline unchanged

import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchEvaluation,
  getEffectiveEvalMode,
  isParallelMode,
  previewDispatch,
  EVAL_MODES,
  COMPONENT_TYPE,
} from './eval-mode-dispatcher.mjs';
import {
  detectComponentType,
  determineRoutingTargets,
  getEvalMode,
  CONFIDENCE_THRESHOLD,
} from './solution-capability-router.mjs';

// ─── Env var helpers ─────────────────────────────────────────────────────────

let _savedMode;

function saveEnv() {
  _savedMode = process.env.WARDLEY_EVAL_MODE;
}

function restoreEnv() {
  if (_savedMode !== undefined) {
    process.env.WARDLEY_EVAL_MODE = _savedMode;
  } else {
    delete process.env.WARDLEY_EVAL_MODE;
  }
}

function setExclusiveMode() {
  delete process.env.WARDLEY_EVAL_MODE;
}

function setParallelMode() {
  process.env.WARDLEY_EVAL_MODE = 'parallel';
}

// ─── Mock Strategy Factories ────────────────────────────────────────────────

/**
 * Track which strategy types were called.
 * Returns mock factories that record invocations and return predictable results.
 */
function createMockFactories() {
  const calls = {
    capability: [],
    solution: [],
  };

  const createCapabilityInstance = (Cls) => {
    calls.capability.push(Cls.method || Cls.name || 'unknown');
    return {
      evaluate: async (component) => ({
        evolution: 0.65,
        confidence: 0.80,
        method: Cls.method || 'mock-capability',
      }),
    };
  };

  const createSolutionInstance = (Cls) => {
    calls.solution.push(Cls.method || Cls.name || 'unknown');
    return {
      evaluate: async (component) => ({
        evolution: 0.55,
        confidence: 0.75,
        method: Cls.method || 'mock-solution',
        properties: [],
      }),
    };
  };

  return { createCapabilityInstance, createSolutionInstance, calls };
}

// ─── 1. Env Var Handling ────────────────────────────────────────────────────

describe('WARDLEY_EVAL_MODE env var handling', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('defaults to exclusive when env var is unset', () => {
    delete process.env.WARDLEY_EVAL_MODE;
    assert.equal(getEffectiveEvalMode(), EVAL_MODES.EXCLUSIVE);
  });

  it('returns exclusive when explicitly set to "exclusive"', () => {
    process.env.WARDLEY_EVAL_MODE = 'exclusive';
    assert.equal(getEffectiveEvalMode(), EVAL_MODES.EXCLUSIVE);
  });

  it('returns parallel when set to "parallel"', () => {
    process.env.WARDLEY_EVAL_MODE = 'parallel';
    assert.equal(getEffectiveEvalMode(), EVAL_MODES.PARALLEL);
  });

  it('is case-insensitive for "PARALLEL"', () => {
    process.env.WARDLEY_EVAL_MODE = 'PARALLEL';
    assert.equal(getEffectiveEvalMode(), EVAL_MODES.PARALLEL);
  });

  it('is case-insensitive for "Exclusive"', () => {
    process.env.WARDLEY_EVAL_MODE = 'Exclusive';
    assert.equal(getEffectiveEvalMode(), EVAL_MODES.EXCLUSIVE);
  });

  it('defaults to exclusive for unrecognized values', () => {
    process.env.WARDLEY_EVAL_MODE = 'foobar';
    assert.equal(getEffectiveEvalMode(), EVAL_MODES.EXCLUSIVE);
  });

  it('handles whitespace in env var', () => {
    process.env.WARDLEY_EVAL_MODE = '  parallel  ';
    assert.equal(getEffectiveEvalMode(), EVAL_MODES.PARALLEL);
  });

  it('handles empty string as exclusive (default)', () => {
    process.env.WARDLEY_EVAL_MODE = '';
    assert.equal(getEffectiveEvalMode(), EVAL_MODES.EXCLUSIVE);
  });
});

// ─── 2. isParallelMode Helper ───────────────────────────────────────────────

describe('isParallelMode()', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('returns false when mode is exclusive (default)', () => {
    delete process.env.WARDLEY_EVAL_MODE;
    assert.equal(isParallelMode(), false);
  });

  it('returns true when mode is parallel', () => {
    process.env.WARDLEY_EVAL_MODE = 'parallel';
    assert.equal(isParallelMode(), true);
  });

  it('returns false for unrecognized values', () => {
    process.env.WARDLEY_EVAL_MODE = 'both';
    assert.equal(isParallelMode(), false);
  });
});

// ─── 3. Preview Dispatch (dry-run) ──────────────────────────────────────────

describe('previewDispatch()', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('previews solution routing in exclusive mode', () => {
    setExclusiveMode();
    const result = previewDispatch('Kubernetes');

    assert.equal(result.detection.type, COMPONENT_TYPE.SOLUTION);
    assert.equal(result.evalMode, EVAL_MODES.EXCLUSIVE);
    assert.equal(result.targets.useSolutionStrategies, true);
    assert.equal(result.targets.useCapabilityStrategies, false);
  });

  it('previews capability routing in exclusive mode', () => {
    setExclusiveMode();
    const result = previewDispatch('CRM');

    assert.equal(result.detection.type, COMPONENT_TYPE.CAPABILITY);
    assert.equal(result.evalMode, EVAL_MODES.EXCLUSIVE);
    assert.equal(result.targets.useSolutionStrategies, false);
    assert.equal(result.targets.useCapabilityStrategies, true);
  });

  it('previews both targets in parallel mode for solution', () => {
    setParallelMode();
    const result = previewDispatch('Kubernetes');

    assert.equal(result.evalMode, EVAL_MODES.PARALLEL);
    assert.equal(result.targets.useSolutionStrategies, true);
    assert.equal(result.targets.useCapabilityStrategies, true);
  });

  it('previews both targets in parallel mode for capability', () => {
    setParallelMode();
    const result = previewDispatch('container orchestration');

    assert.equal(result.evalMode, EVAL_MODES.PARALLEL);
    assert.equal(result.targets.useSolutionStrategies, true);
    assert.equal(result.targets.useCapabilityStrategies, true);
  });

  it('includes detection metadata for solutions', () => {
    const result = previewDispatch('Salesforce');
    assert.ok(result.detection.canonical);
    assert.ok(result.detection.vendor);
    assert.ok(result.detection.confidence >= 0.90);
    assert.equal(result.detection.needsFallback, false);
  });

  it('includes detection metadata for capabilities', () => {
    const result = previewDispatch('data analytics');
    assert.ok(result.detection.confidence >= 0.85);
  });
});

// ─── 4. Exclusive Mode Routing (default) ────────────────────────────────────

describe('dispatchEvaluation — exclusive mode', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('routes known solution to solution-strategies ONLY', async () => {
    setExclusiveMode();
    const detection = detectComponentType('Kubernetes');
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Kubernetes', description: 'Container orchestration platform' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(result.evalMode, EVAL_MODES.EXCLUSIVE);
    assert.equal(result.usedSolutionStrategies, true);
    assert.equal(result.usedCapabilityStrategies, false);
    assert.ok(calls.solution.length > 0, 'should have called solution strategies');
    assert.equal(calls.capability.length, 0, 'should NOT have called capability strategies');
  });

  it('routes known capability to capability strategies ONLY', async () => {
    setExclusiveMode();
    const detection = detectComponentType('CRM');
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'CRM', description: 'Customer relationship management' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(result.evalMode, EVAL_MODES.EXCLUSIVE);
    assert.equal(result.usedSolutionStrategies, false);
    assert.equal(result.usedCapabilityStrategies, true);
    assert.equal(calls.solution.length, 0, 'should NOT have called solution strategies');
    assert.ok(calls.capability.length > 0, 'should have called capability strategies');
  });

  it('returns detection in result', async () => {
    setExclusiveMode();
    const detection = detectComponentType('Docker');
    const { createCapabilityInstance, createSolutionInstance } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Docker', description: 'Containerization platform' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.deepEqual(result.detection, detection);
    assert.equal(result.detection.type, COMPONENT_TYPE.SOLUTION);
  });

  it('does NOT namespace keys in exclusive mode', async () => {
    setExclusiveMode();
    const detection = detectComponentType('Kubernetes');
    const { createCapabilityInstance, createSolutionInstance } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Kubernetes' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    const keys = Object.keys(result.evaluations);
    for (const key of keys) {
      assert.ok(!key.includes(':'), `exclusive mode key "${key}" should NOT have namespace prefix`);
    }
  });
});

// ─── 5. Parallel Mode Routing ───────────────────────────────────────────────

describe('dispatchEvaluation — parallel mode', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('routes solution to BOTH strategy sets', async () => {
    setParallelMode();
    const detection = detectComponentType('Kubernetes');
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Kubernetes', description: 'Container orchestration' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(result.evalMode, EVAL_MODES.PARALLEL);
    assert.equal(result.usedSolutionStrategies, true);
    assert.equal(result.usedCapabilityStrategies, true);
    assert.ok(calls.solution.length > 0, 'should have called solution strategies');
    assert.ok(calls.capability.length > 0, 'should have called capability strategies');
  });

  it('routes capability to BOTH strategy sets', async () => {
    setParallelMode();
    const detection = detectComponentType('CRM');
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'CRM', description: 'Customer relationship management' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(result.evalMode, EVAL_MODES.PARALLEL);
    assert.equal(result.usedSolutionStrategies, true);
    assert.equal(result.usedCapabilityStrategies, true);
    assert.ok(calls.solution.length > 0, 'should have called solution strategies');
    assert.ok(calls.capability.length > 0, 'should have called capability strategies');
  });

  it('namespaces results with "solution:" and "capability:" prefixes', async () => {
    setParallelMode();
    const detection = detectComponentType('Kubernetes');
    const { createCapabilityInstance, createSolutionInstance } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Kubernetes' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    const keys = Object.keys(result.evaluations);
    const solutionKeys = keys.filter(k => k.startsWith('solution:'));
    const capabilityKeys = keys.filter(k => k.startsWith('capability:'));

    assert.ok(solutionKeys.length > 0 || keys.length === 0,
      'parallel mode should namespace solution results with "solution:" prefix');
    assert.ok(capabilityKeys.length > 0 || keys.length === 0,
      'parallel mode should namespace capability results with "capability:" prefix');

    // No un-namespaced keys
    const unnamespaced = keys.filter(k => !k.startsWith('solution:') && !k.startsWith('capability:'));
    assert.equal(unnamespaced.length, 0, 'all keys in parallel mode should be namespaced');
  });

  it('avoids key collisions when both sets have results', async () => {
    setParallelMode();
    const detection = detectComponentType('Kubernetes');
    const { createCapabilityInstance, createSolutionInstance } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Kubernetes' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    // Check uniqueness of keys
    const keys = Object.keys(result.evaluations);
    const uniqueKeys = new Set(keys);
    assert.equal(keys.length, uniqueKeys.size, 'all keys should be unique (no collisions)');
  });
});

// ─── 6. Auto-detection when no detection provided ───────────────────────────

describe('dispatchEvaluation — auto-detection', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('auto-detects solution when detection=null', async () => {
    setExclusiveMode();
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Kubernetes', description: 'Container orchestration platform' },
      null, // no detection provided
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(result.detection.type, COMPONENT_TYPE.SOLUTION);
    assert.ok(calls.solution.length > 0, 'auto-detected solution should route to solution strategies');
    assert.equal(calls.capability.length, 0);
  });

  it('auto-detects capability when detection=null', async () => {
    setExclusiveMode();
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'CRM', description: 'Customer relationship management' },
      null,
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(result.detection.type, COMPONENT_TYPE.CAPABILITY);
    assert.equal(calls.solution.length, 0);
    assert.ok(calls.capability.length > 0, 'auto-detected capability should route to capability strategies');
  });
});

// ─── 7. Enriched Component for Solution Strategies ──────────────────────────

describe('dispatchEvaluation — enriched component metadata', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('enriches solution component with isSolution flag', async () => {
    setExclusiveMode();
    const detection = detectComponentType('Kubernetes');
    const { createCapabilityInstance, createSolutionInstance } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Kubernetes' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(result.enrichedComponent.isSolution, true);
    assert.ok(result.enrichedComponent.routerConfidence >= 0.90);
    assert.equal(result.enrichedComponent.canonicalName, 'Kubernetes');
    assert.equal(result.enrichedComponent.vendor, 'CNCF');
  });

  it('enriches capability component with isSolution=false', async () => {
    setExclusiveMode();
    const detection = detectComponentType('CRM');
    const { createCapabilityInstance, createSolutionInstance } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'CRM' },
      detection,
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(result.enrichedComponent.isSolution, false);
  });
});

// ─── 8. Result Shape Validation ─────────────────────────────────────────────

describe('dispatchEvaluation — result shape', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('returns all required fields', async () => {
    setExclusiveMode();
    const { createCapabilityInstance, createSolutionInstance } = createMockFactories();

    const result = await dispatchEvaluation(
      { name: 'Kubernetes' },
      detectComponentType('Kubernetes'),
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(typeof result.evaluations, 'object');
    assert.equal(typeof result.detection, 'object');
    assert.equal(typeof result.evalMode, 'string');
    assert.equal(typeof result.usedSolutionStrategies, 'boolean');
    assert.equal(typeof result.usedCapabilityStrategies, 'boolean');
    assert.equal(typeof result.enrichedComponent, 'object');
  });

  it('evalMode matches env var', async () => {
    setExclusiveMode();
    const { createCapabilityInstance, createSolutionInstance } = createMockFactories();

    const exclusiveResult = await dispatchEvaluation(
      { name: 'Kubernetes' },
      detectComponentType('Kubernetes'),
      { createCapabilityInstance, createSolutionInstance }
    );
    assert.equal(exclusiveResult.evalMode, EVAL_MODES.EXCLUSIVE);

    setParallelMode();
    const parallelResult = await dispatchEvaluation(
      { name: 'Kubernetes' },
      detectComponentType('Kubernetes'),
      { createCapabilityInstance, createSolutionInstance }
    );
    assert.equal(parallelResult.evalMode, EVAL_MODES.PARALLEL);
  });
});

// ─── 9. Exclusive vs Parallel Consistency ───────────────────────────────────

describe('exclusive vs parallel consistency', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('exclusive mode for Kubernetes: ONLY solution strategies', async () => {
    setExclusiveMode();
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    await dispatchEvaluation(
      { name: 'Kubernetes' },
      detectComponentType('Kubernetes'),
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.ok(calls.solution.length > 0, 'Kubernetes exclusive: solution called');
    assert.equal(calls.capability.length, 0, 'Kubernetes exclusive: capability NOT called');
  });

  it('exclusive mode for Salesforce: ONLY solution strategies', async () => {
    setExclusiveMode();
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    await dispatchEvaluation(
      { name: 'Salesforce' },
      detectComponentType('Salesforce'),
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.ok(calls.solution.length > 0, 'Salesforce exclusive: solution called');
    assert.equal(calls.capability.length, 0, 'Salesforce exclusive: capability NOT called');
  });

  it('exclusive mode for ERP: ONLY capability strategies', async () => {
    setExclusiveMode();
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    await dispatchEvaluation(
      { name: 'ERP' },
      detectComponentType('ERP'),
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(calls.solution.length, 0, 'ERP exclusive: solution NOT called');
    assert.ok(calls.capability.length > 0, 'ERP exclusive: capability called');
  });

  it('exclusive mode for container orchestration: ONLY capability strategies', async () => {
    setExclusiveMode();
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    await dispatchEvaluation(
      { name: 'container orchestration' },
      detectComponentType('container orchestration'),
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.equal(calls.solution.length, 0, 'container orch exclusive: solution NOT called');
    assert.ok(calls.capability.length > 0, 'container orch exclusive: capability called');
  });

  it('parallel mode for Kubernetes: BOTH strategy sets', async () => {
    setParallelMode();
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    await dispatchEvaluation(
      { name: 'Kubernetes' },
      detectComponentType('Kubernetes'),
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.ok(calls.solution.length > 0, 'Kubernetes parallel: solution called');
    assert.ok(calls.capability.length > 0, 'Kubernetes parallel: capability called');
  });

  it('parallel mode for ERP: BOTH strategy sets', async () => {
    setParallelMode();
    const { createCapabilityInstance, createSolutionInstance, calls } = createMockFactories();

    await dispatchEvaluation(
      { name: 'ERP' },
      detectComponentType('ERP'),
      { createCapabilityInstance, createSolutionInstance }
    );

    assert.ok(calls.solution.length > 0, 'ERP parallel: solution called');
    assert.ok(calls.capability.length > 0, 'ERP parallel: capability called');
  });
});

// ─── 10. Multiple Solutions & Capabilities ──────────────────────────────────

describe('routing consistency across many components', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  const solutions = ['Kubernetes', 'Salesforce', 'Docker', 'AWS', 'Terraform', 'PostgreSQL', 'Kafka', 'Stripe'];
  const capabilities = ['CRM', 'ERP', 'DevOps', 'CI/CD', 'container orchestration', 'identity management', 'monitoring'];

  for (const name of solutions) {
    it(`exclusive: "${name}" → solution-strategies ONLY`, () => {
      setExclusiveMode();
      const preview = previewDispatch(name);
      assert.equal(preview.targets.useSolutionStrategies, true, `${name}: useSolutionStrategies`);
      assert.equal(preview.targets.useCapabilityStrategies, false, `${name}: useCapabilityStrategies`);
    });

    it(`parallel: "${name}" → BOTH strategy sets`, () => {
      setParallelMode();
      const preview = previewDispatch(name);
      assert.equal(preview.targets.useSolutionStrategies, true, `${name}: useSolutionStrategies`);
      assert.equal(preview.targets.useCapabilityStrategies, true, `${name}: useCapabilityStrategies`);
    });
  }

  for (const name of capabilities) {
    it(`exclusive: "${name}" → capability strategies ONLY`, () => {
      setExclusiveMode();
      const preview = previewDispatch(name);
      assert.equal(preview.targets.useSolutionStrategies, false, `${name}: useSolutionStrategies`);
      assert.equal(preview.targets.useCapabilityStrategies, true, `${name}: useCapabilityStrategies`);
    });

    it(`parallel: "${name}" → BOTH strategy sets`, () => {
      setParallelMode();
      const preview = previewDispatch(name);
      assert.equal(preview.targets.useSolutionStrategies, true, `${name}: useSolutionStrategies`);
      assert.equal(preview.targets.useCapabilityStrategies, true, `${name}: useCapabilityStrategies`);
    });
  }
});

// ─── 11. Exported Constants ─────────────────────────────────────────────────

describe('exported constants', () => {
  it('EVAL_MODES.EXCLUSIVE is "exclusive"', () => {
    assert.equal(EVAL_MODES.EXCLUSIVE, 'exclusive');
  });

  it('EVAL_MODES.PARALLEL is "parallel"', () => {
    assert.equal(EVAL_MODES.PARALLEL, 'parallel');
  });

  it('COMPONENT_TYPE.SOLUTION is "solution"', () => {
    assert.equal(COMPONENT_TYPE.SOLUTION, 'solution');
  });

  it('COMPONENT_TYPE.CAPABILITY is "capability"', () => {
    assert.equal(COMPONENT_TYPE.CAPABILITY, 'capability');
  });
});
