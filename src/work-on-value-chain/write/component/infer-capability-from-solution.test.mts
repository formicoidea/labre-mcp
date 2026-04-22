// Unit tests for pipeline-capability-inference: capabilityToLabel + inferCapabilityFromSolution.
// Migrated from the former self-test block — LLM is injected as a mock.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityToLabel,
  inferCapabilityFromSolution,
} from './infer-capability-from-solution.mjs';

describe('capabilityToLabel — activity', () => {
  it('removes leading verb and nominalizes', () => {
    assert.equal(capabilityToLabel('Orchestrate containers', 'activity'), 'Containers Orchestration');
  });

  it('handles multi-word objects', () => {
    assert.equal(capabilityToLabel('Manage customer relationships', 'activity'), 'Customer Relationships Management');
  });

  it('handles deploy verb', () => {
    assert.equal(capabilityToLabel('Deploy microservices', 'activity'), 'Microservices Deployment');
  });

  it('falls back to title-case when no verb is detected', () => {
    assert.equal(capabilityToLabel('container orchestration', 'activity'), 'Container Orchestration');
  });
});

describe('capabilityToLabel — practice / knowledge / data', () => {
  it('practice "how to X" delegates to activity formatter', () => {
    assert.equal(capabilityToLabel('how to manage IT services', 'practice'), 'IT Services Management');
  });

  it('knowledge "expertise in X" → "X Expertise"', () => {
    assert.equal(capabilityToLabel('technical expertise in welding', 'knowledge'), 'Welding Expertise');
  });

  it('knowledge "skills for X" → "X Skills"', () => {
    assert.equal(capabilityToLabel('interpersonal skills for coaching', 'knowledge'), 'Coaching Skills');
  });

  it('data title-cases as-is', () => {
    assert.equal(capabilityToLabel('ambient temperature', 'data'), 'Ambient Temperature');
  });

  it('preserves abbreviations in title-case', () => {
    assert.equal(capabilityToLabel('CRM systems', 'data'), 'CRM Systems');
  });
});

describe('capabilityToLabel — edge cases', () => {
  it('returns default label on empty input', () => {
    assert.equal(capabilityToLabel('', 'activity'), 'Capability');
  });
});

describe('inferCapabilityFromSolution — input validation', () => {
  it('rejects empty solutionName', async () => {
    await assert.rejects(
      () => inferCapabilityFromSolution('', { llmCall: async () => '' }),
      /non-empty string/,
    );
  });

  it('rejects missing llmCall', async () => {
    await assert.rejects(
      () => inferCapabilityFromSolution('Kubernetes', {}),
      /llmCall function is required/,
    );
  });
});

describe('inferCapabilityFromSolution — with mock LLM', () => {
  it('returns a structured inference for Kubernetes (activity)', async () => {
    const mockLLM = async () => [
      'type=component',
      'nature=activity',
      'capability=Orchestrate containers',
      'confidence=0.92',
      'justification=Kubernetes is a container orchestration platform',
    ].join('\n');

    const result = await inferCapabilityFromSolution('Kubernetes', {
      description: 'Container orchestration platform',
      llmCall: mockLLM,
    });

    assert.equal(result.solutionName, 'Kubernetes');
    assert.equal(result.capability, 'Orchestrate containers');
    assert.equal(result.capabilityLabel, 'Containers Orchestration');
    assert.equal(result.nature, 'activity');
    assert.equal(result.wardleyType, 'component');
    assert.equal(result.confidence, 0.92);
    assert.equal(result.inferred, true);
  });

  it('returns a practice inference for Scrum', async () => {
    const mockLLM = async () => [
      'type=component',
      'nature=practice',
      'capability=how to manage a project with agile iterations',
      'confidence=0.88',
      'justification=Scrum is a named agile project management methodology',
    ].join('\n');

    const result = await inferCapabilityFromSolution('Scrum', {
      description: 'Agile project management framework',
      llmCall: mockLLM,
    });

    assert.equal(result.nature, 'practice');
    assert.equal(result.inferred, true);
    assert.ok(result.capabilityLabel.includes('Management'));
  });

  it('trims whitespace around solutionName', async () => {
    const mockLLM = async () => 'type=component\nnature=activity\ncapability=Do stuff\nconfidence=0.8\n';
    const result = await inferCapabilityFromSolution('  Kubernetes  ', { llmCall: mockLLM });
    assert.equal(result.solutionName, 'Kubernetes');
  });
});
