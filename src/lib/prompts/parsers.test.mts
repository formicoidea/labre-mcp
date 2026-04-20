import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyValueBlock, parseDelimitedBlock } from './parsers.mjs';

describe('parseKeyValueBlock — anchored, strict `=`', () => {
  it('extracts simple key=value fields', () => {
    const text = 'phase=3\njustification=because\nconfidence=0.9';
    const out = parseKeyValueBlock(text, ['phase', 'justification', 'confidence']);
    assert.deepEqual(out, { phase: '3', justification: 'because', confidence: '0.9' });
  });

  it('returns undefined for missing keys', () => {
    const out = parseKeyValueBlock('phase=3', ['phase', 'missing']);
    assert.equal(out.phase, '3');
    assert.equal(out.missing, undefined);
  });

  it('is case-insensitive on keys', () => {
    const out = parseKeyValueBlock('PHASE=3', ['phase']);
    assert.equal(out.phase, '3');
  });

  it('ignores prose before the key=value block', () => {
    const text = 'Some prose.\nMore prose.\nphase=2\nconfidence=0.8';
    const out = parseKeyValueBlock(text, ['phase', 'confidence']);
    assert.deepEqual(out, { phase: '2', confidence: '0.8' });
  });

  it('does not match key=value mid-line (anchored mode)', () => {
    const out = parseKeyValueBlock('prefix phase=3 suffix', ['phase']);
    assert.equal(out.phase, undefined);
  });

  it('trims surrounding whitespace from values', () => {
    const out = parseKeyValueBlock('reasoning=   hello world   ', ['reasoning']);
    assert.equal(out.reasoning, 'hello world');
  });
});

describe('parseKeyValueBlock — unanchored, `any` separator', () => {
  it('matches key anywhere in text with flexible separator', () => {
    const out = parseKeyValueBlock('Result: evolution: 0.75, confidence=0.9', ['evolution', 'confidence'], {
      separator: 'any',
      anchored: false,
    });
    assert.equal(out.evolution, '0.75, confidence=0.9');
    assert.equal(out.confidence, '0.9');
  });

  it('matches key followed by whitespace separator', () => {
    const out = parseKeyValueBlock('milestone_name Apollo 11\nmilestone_date 1969', ['milestone_name', 'milestone_date'], {
      separator: 'any',
      anchored: false,
    });
    assert.equal(out.milestone_name, 'Apollo 11');
    assert.equal(out.milestone_date, '1969');
  });
});

describe('parseDelimitedBlock', () => {
  it('extracts content between markers', () => {
    const text = 'prose\nEVIDENCE_START\nline1\nline2\nEVIDENCE_END\ntail';
    assert.equal(parseDelimitedBlock(text, 'EVIDENCE_START', 'EVIDENCE_END'), 'line1\nline2');
  });

  it('returns null when markers missing', () => {
    assert.equal(parseDelimitedBlock('no markers here', 'START', 'END'), null);
  });

  it('is case-insensitive on markers', () => {
    const text = 'references_start\ncontent\nreferences_end';
    assert.equal(parseDelimitedBlock(text, 'REFERENCES_START', 'REFERENCES_END'), 'content');
  });

  it('returns first block when multiple match (non-greedy)', () => {
    const text = 'START\nfirst\nEND\nprose\nSTART\nsecond\nEND';
    assert.equal(parseDelimitedBlock(text, 'START', 'END'), 'first');
  });
});
