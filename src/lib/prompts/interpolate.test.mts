import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate } from './interpolate.mjs';

describe('interpolate', () => {
  it('substitutes a single variable', () => {
    assert.equal(interpolate('Hello {{name}}!', { name: 'world' }), 'Hello world!');
  });

  it('substitutes multiple variables', () => {
    const out = interpolate('{{a}} and {{b}} and {{a}}', { a: 'X', b: 'Y' });
    assert.equal(out, 'X and Y and X');
  });

  it('replaces all occurrences of the same variable (diverges from chained .replace)', () => {
    const out = interpolate('{{x}} {{x}} {{x}}', { x: 'Z' });
    assert.equal(out, 'Z Z Z');
  });

  it('replaces missing variables with empty string', () => {
    assert.equal(interpolate('Hello {{name}}!', {}), 'Hello !');
  });

  it('ignores extra variables not in template', () => {
    assert.equal(interpolate('Hello {{name}}', { name: 'a', extra: 'b' }), 'Hello a');
  });

  it('treats non-word braces as literal', () => {
    assert.equal(interpolate('{not a var} {{x}}', { x: 'ok' }), '{not a var} ok');
  });
});
