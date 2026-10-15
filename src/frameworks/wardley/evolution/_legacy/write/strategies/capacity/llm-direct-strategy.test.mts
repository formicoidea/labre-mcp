// Guard tests for the llm-direct reply parser, corrected from the
// wardley-evolution-benchmark port. Would have caught: the first mention of
// "evolution" in the prose read as the answer, and a non-numeric value
// flowing on as NaN.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLLMDirectResponse, yearOf } from './llm-direct-strategy.mjs';

describe('parseLLMDirectResponse', () => {
  it('reads the concluding lines, not the first mention in the reasoning', () => {
    const reply = 'The evolution of this market is fast; evolution 0.9 would be too high.\n\nevolution=0.42\nconfidence=0.7';
    assert.deepEqual(parseLLMDirectResponse(reply), { evolution: 0.42, confidence: 0.7 });
  });

  it('keeps the last evolution= line when the model revises itself', () => {
    assert.equal(parseLLMDirectResponse('evolution=0.3\nOn reflection:\n  Evolution = 0.35\nconfidence=0.5').evolution, 0.35);
  });

  it('defaults an absent confidence to 0.6', () => {
    assert.equal(parseLLMDirectResponse('evolution=0.5').confidence, 0.6);
  });

  it('throws without an evolution= line, and on a value that is not a number', () => {
    assert.throws(() => parseLLMDirectResponse('The evolution is about 0.5.'), /no "evolution=" line/);
    assert.throws(() => parseLLMDirectResponse('evolution=high\nconfidence=0.5'), /not a number/);
    assert.throws(() => parseLLMDirectResponse('evolution=0.5\nconfidence=sure'), /not a number/);
  });
});

// Would have caught: the timeline strategy's milestone years read as epoch
// milliseconds, so every milestone was asked about 1970.
describe('yearOf', () => {
  it('reads a bare integer year as a year, and anything else as a date', () => {
    assert.equal(yearOf(1995), 1995);
    assert.equal(yearOf('2010-06-15'), 2010);
    assert.equal(yearOf(new Date(2020, 5, 1)), 2020);
  });
});
