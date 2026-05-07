// Unit tests for parseConversationalInput — the pure parsing surface of skill-handler.
// Migrated from the former self-test block.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationalInput } from './skill-handler.mjs';

describe('parseConversationalInput — structured formats', () => {
  it('parses newline-separated key:value', () => {
    const r = parseConversationalInput(
      'Component: ERP\nDescription: Enterprise resource planning\nSpace: economic\nCertitude: 0.9\nUbiquity: 0.85',
    );
    assert.equal(r.name, 'ERP');
    assert.equal(r.space, 'economic');
    assert.equal(r.certitude, 0.9);
    assert.equal(r.ubiquity, 0.85);
    assert.ok(r.description?.includes('Enterprise'));
  });

  it('parses bullet list with aliases', () => {
    const r = parseConversationalInput(
      '- Name: LLM\n- Context: Text generation for coding\n- Strategy: s-curve',
    );
    assert.equal(r.name, 'LLM');
    assert.equal(r.strategy, 'write:capacity:s-curve');
    assert.ok(r.description?.includes('Text generation'));
  });

  it('parses comma-separated key:value', () => {
    const r = parseConversationalInput(
      'Component: Docker, Strategy: auto, Context: containerization',
    );
    assert.equal(r.name, 'Docker');
    assert.equal(r.strategy, 'auto');
  });

  it('ignores out-of-range numeric values', () => {
    const r = parseConversationalInput('Component: X\nCertitude: 1.5');
    assert.equal(r.name, 'X');
    assert.equal(r.certitude, undefined);
  });
});

describe('parseConversationalInput — natural language', () => {
  it('strips "Estimate evolution for" preamble', () => {
    const r = parseConversationalInput('Estimate evolution for ERP in enterprise software');
    assert.equal(r.name, 'ERP');
    assert.ok(r.description?.includes('enterprise'));
  });

  it('parses quoted component name', () => {
    const r = parseConversationalInput('"Wardley Mapping" decision making framework');
    assert.equal(r.name, 'Wardley Mapping');
  });

  it('parses minimal single-word input', () => {
    const r = parseConversationalInput('Electricity');
    assert.equal(r.name, 'Electricity');
  });

  it('parses dash-separated "Name - description"', () => {
    const r = parseConversationalInput('CRM - customer relationship management for sales');
    assert.equal(r.name, 'CRM');
    assert.ok(r.description?.includes('customer'));
  });

  it('detects social_good space in natural language', () => {
    const r = parseConversationalInput('Air in the social good space');
    assert.equal(r.name, 'Air');
    assert.equal(r.space, 'social_good');
  });
});

describe('parseConversationalInput — error handling', () => {
  it('throws on empty string', () => {
    assert.throws(() => parseConversationalInput(''), /non-empty string/);
  });

  it('throws on whitespace-only string', () => {
    assert.throws(() => parseConversationalInput('   '), /non-empty string/);
  });

  it('throws on null', () => {
    assert.throws(() => parseConversationalInput(null), /non-empty string/);
  });

  it('throws on non-string', () => {
    assert.throws(() => parseConversationalInput(42), /non-empty string/);
  });
});
