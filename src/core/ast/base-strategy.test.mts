import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { METHOD_ID_5_SEGMENT_REGEX, methodIdSchema } from './base-strategy.mjs';

describe('METHOD_ID_5_SEGMENT_REGEX', () => {
  it('accepts canonical 5-segment ids', () => {
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('wardley:evolution:write:capacity:s-curve'));
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('common:layout:write:labels:default'));
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e'));
  });

  it('rejects ids that miss segments', () => {
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('foo'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('write:capacity:s-curve'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e:f'));
  });

  it('rejects uppercase, leading digits, and disallowed characters', () => {
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('Wardley:evolution:write:capacity:s-curve'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('wardley:evolution:write:capacity:S-Curve'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('1wardley:evolution:write:capacity:s-curve'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('wardley:evolution:write:capacity:s_curve'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('wardley:evolution:write:capacity:'));
  });
});

describe('methodIdSchema (Zod)', () => {
  it('parses valid ids', () => {
    const parsed = methodIdSchema.parse('wardley:evolution:write:capacity:s-curve');
    assert.equal(parsed, 'wardley:evolution:write:capacity:s-curve');
  });

  it('throws on invalid ids', () => {
    assert.throws(() => methodIdSchema.parse('foo'));
    assert.throws(() => methodIdSchema.parse('write:capacity:s-curve'));
    assert.throws(() => methodIdSchema.parse('Wardley:evolution:write:capacity:s-curve'));
  });
});
