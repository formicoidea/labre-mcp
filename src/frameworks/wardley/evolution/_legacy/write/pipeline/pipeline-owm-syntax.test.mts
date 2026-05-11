// Tests for OWM (onlinewardleymaps.com) syntax generation in pipeline-enriched.mjs
//
// Validates that generateOwmSyntax produces correct .wm format with:
//   - component declarations with [visibility, evolution] coordinates
//   - pipeline declaration wrapping inner components
//   - Inner components ordered by evolution (legacy → SotA)
//   - Proper quoting for names with spaces
//   - Nature metadata as comment

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateOwmSyntax } from './pipeline-enriched.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse OWM lines into structured objects for assertions.
 */
function parseOwmLines(owm) {
  const lines = owm.split('\n');
  const result = { comments: [], outerComponent: null, pipeline: null, innerComponents: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) {
      result.comments.push(trimmed);
    } else if (trimmed.startsWith('component') && !line.startsWith('    ')) {
      // Outer component line: component "Name" [vis, evo] label [x, y]
      result.outerComponent = trimmed;
    } else if (trimmed.startsWith('pipeline')) {
      result.pipeline = trimmed;
    } else if (trimmed.startsWith('component') && line.startsWith('    ')) {
      // Inner component
      result.innerComponents.push(trimmed);
    }
  }

  return result;
}

/**
 * Extract evolution value from an inner component line.
 * e.g. 'component Kubernetes [0.62] label [-61, -23]' → 0.62
 */
function extractInnerEvolution(line) {
  const match = line.match(/\[([0-9.]+)\]/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Extract component name from a component line.
 * Handles both quoted and unquoted names.
 */
function extractComponentName(line) {
  const quoted = line.match(/component\s+"([^"]+)"/);
  if (quoted) return quoted[1];
  const unquoted = line.match(/component\s+(\S+)/);
  return unquoted ? unquoted[1] : null;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('generateOwmSyntax', () => {

  describe('3-component pipeline (full)', () => {
    const owm = generateOwmSyntax({
      capabilityLabel: 'Container Orchestration',
      capabilityEvolution: 0.55,
      componentName: 'Kubernetes',
      componentEvolution: 0.62,
      sotaName: 'Nomad',
      sotaEvolution: 0.78,
      legacyName: 'Docker Swarm',
      legacyEvolution: 0.45,
      nature: 'activity',
    });

    const parsed = parseOwmLines(owm);

    it('produces a nature comment', () => {
      assert.ok(parsed.comments.some(c => c.includes('nature: activity')));
    });

    it('produces an outer component with [visibility, pipeline_min]', () => {
      assert.ok(parsed.outerComponent, 'outer component should exist');
      assert.ok(parsed.outerComponent.includes('"Container Orchestration"'));
      // pipeline_min = min(0.45, 0.62, 0.78) - 0.05 = 0.40
      assert.ok(parsed.outerComponent.includes('[0.51, 0.4]'));
      assert.ok(parsed.outerComponent.includes('label'));
    });

    it('produces a pipeline declaration matching outer component name', () => {
      assert.ok(parsed.pipeline);
      assert.ok(parsed.pipeline.includes('"Container Orchestration"'));
    });

    it('produces 3 inner components', () => {
      assert.equal(parsed.innerComponents.length, 3);
    });

    it('orders inner components by evolution ascending (legacy → SotA)', () => {
      const evolutions = parsed.innerComponents.map(extractInnerEvolution);
      for (let i = 1; i < evolutions.length; i++) {
        assert.ok(evolutions[i] >= evolutions[i - 1],
          `evolution[${i}]=${evolutions[i]} should be >= evolution[${i-1}]=${evolutions[i-1]}`);
      }
    });

    it('contains all 3 component names', () => {
      const names = parsed.innerComponents.map(extractComponentName);
      assert.ok(names.includes('Docker Swarm'), 'should contain legacy');
      assert.ok(names.includes('Kubernetes'), 'should contain input');
      assert.ok(names.includes('Nomad'), 'should contain SotA');
    });

    it('produces valid OWM with opening and closing braces', () => {
      assert.ok(owm.includes('{'));
      assert.ok(owm.includes('}'));
    });
  });

  describe('single component (capability pivot only)', () => {
    const owm = generateOwmSyntax({
      capabilityLabel: 'Container Orchestration',
      capabilityEvolution: 0.55,
      componentName: 'Kubernetes',
      componentEvolution: 0.62,
      nature: 'activity',
    });

    const parsed = parseOwmLines(owm);

    it('produces 1 inner component when no SotA/legacy', () => {
      assert.equal(parsed.innerComponents.length, 1);
    });

    it('the inner component is the input component', () => {
      assert.equal(extractComponentName(parsed.innerComponents[0]), 'Kubernetes');
    });

    it('pipeline min is component evolution minus margin', () => {
      // 0.62 - 0.05 = 0.57
      assert.ok(parsed.outerComponent.includes('0.57'));
    });
  });

  describe('quoting rules', () => {
    it('quotes names with spaces', () => {
      const owm = generateOwmSyntax({
        capabilityLabel: 'IT Service Management',
        capabilityEvolution: 0.5,
        componentName: 'ServiceNow',
        componentEvolution: 0.65,
      });
      assert.ok(owm.includes('"IT Service Management"'));
      // ServiceNow has no spaces → no quotes
      assert.ok(owm.includes('component ServiceNow'));
    });

    it('does not double-quote single-word names', () => {
      const owm = generateOwmSyntax({
        capabilityLabel: 'Orchestration',
        capabilityEvolution: 0.5,
        componentName: 'Kubernetes',
        componentEvolution: 0.6,
      });
      assert.ok(owm.includes('component Orchestration ['));
      assert.ok(owm.includes('pipeline Orchestration'));
    });
  });

  describe('deduplication', () => {
    it('deduplicates when input component equals SotA name', () => {
      const owm = generateOwmSyntax({
        capabilityLabel: 'Container Orchestration',
        capabilityEvolution: 0.55,
        componentName: 'Kubernetes',
        componentEvolution: 0.62,
        sotaName: 'Kubernetes',
        sotaEvolution: 0.62,
        legacyName: 'Docker Swarm',
        legacyEvolution: 0.45,
      });
      const parsed = parseOwmLines(owm);
      // Should have 2 inner components (deduped Kubernetes)
      assert.equal(parsed.innerComponents.length, 2);
    });
  });

  describe('nature metadata', () => {
    for (const nature of ['activity', 'practice', 'data', 'knowledge']) {
      it(`includes nature="${nature}" as comment`, () => {
        const owm = generateOwmSyntax({
          capabilityLabel: 'Test',
          capabilityEvolution: 0.5,
          componentName: 'TestComp',
          componentEvolution: 0.5,
          nature,
        });
        assert.ok(owm.includes(`// nature: ${nature}`));
      });
    }
  });

  describe('edge cases', () => {
    it('handles evolution at 0 (genesis)', () => {
      const owm = generateOwmSyntax({
        capabilityLabel: 'New Capability',
        capabilityEvolution: 0.05,
        componentName: 'Prototype',
        componentEvolution: 0.05,
        legacyName: 'OldThing',
        legacyEvolution: 0.02,
      });
      const parsed = parseOwmLines(owm);
      // pipeline_min should clamp to 0
      assert.ok(parsed.outerComponent.includes('[0.51, 0]'));
    });

    it('handles evolution at 1 (commodity)', () => {
      const owm = generateOwmSyntax({
        capabilityLabel: 'Electricity',
        capabilityEvolution: 0.95,
        componentName: 'Power Grid',
        componentEvolution: 0.95,
        sotaName: 'Smart Grid',
        sotaEvolution: 0.98,
      });
      const parsed = parseOwmLines(owm);
      const evolutions = parsed.innerComponents.map(extractInnerEvolution);
      assert.ok(evolutions.every(e => e >= 0 && e <= 1));
    });

    it('defaults capabilityLabel to "Capability" when empty', () => {
      const owm = generateOwmSyntax({
        capabilityEvolution: 0.5,
        componentName: 'Test',
        componentEvolution: 0.5,
      });
      assert.ok(owm.includes('Capability'));
    });
  });

  describe('OWM syntax validity', () => {
    it('each inner component line has exactly one [evolution] bracket', () => {
      const owm = generateOwmSyntax({
        capabilityLabel: 'Test Cap',
        capabilityEvolution: 0.5,
        componentName: 'CompA',
        componentEvolution: 0.6,
        sotaName: 'CompB',
        sotaEvolution: 0.8,
        legacyName: 'CompC',
        legacyEvolution: 0.3,
      });
      const parsed = parseOwmLines(owm);
      for (const line of parsed.innerComponents) {
        // Should have [evolution] and label [x, y] — two bracket pairs
        const brackets = line.match(/\[[^\]]+\]/g);
        assert.equal(brackets.length, 2, `Expected 2 bracket pairs in: ${line}`);
      }
    });

    it('outer component has [visibility, evolution] with two values', () => {
      const owm = generateOwmSyntax({
        capabilityLabel: 'Test',
        capabilityEvolution: 0.5,
        componentName: 'X',
        componentEvolution: 0.5,
      });
      const parsed = parseOwmLines(owm);
      const coordMatch = parsed.outerComponent.match(/\[([0-9.]+),\s*([0-9.]+)\]/);
      assert.ok(coordMatch, 'outer component should have [vis, evo] coords');
      const vis = parseFloat(coordMatch[1]);
      const evo = parseFloat(coordMatch[2]);
      assert.ok(vis >= 0 && vis <= 1, 'visibility should be 0-1');
      assert.ok(evo >= 0 && evo <= 1, 'evolution should be 0-1');
    });
  });
});
