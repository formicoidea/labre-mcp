import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { METHOD_ID_5_SEGMENT_REGEX, methodIdSchema } from './base-strategy.mjs';

describe('METHOD_ID_5_SEGMENT_REGEX', () => {
  it('accepts canonical 5-segment ids', () => {
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('wardley:map:value-chain:generate:top-down'));
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('wardley:map:climate:position-functional-in-evolution:s-curve'));
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('render:wardley-map:owm:parse:dsl'));
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('common:toolbox:list:emit:default'));
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e'));
  });

  it('accepts ids with optional @x.y.z SemVer suffix', () => {
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('wardley:map:value-chain:generate:top-down@0.1.0'));
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('wardley:map:climate:position-functional-in-evolution:s-curve@1.2.3'));
    assert.ok(METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e@0.0.1'));
  });

  it('rejects ids that miss segments', () => {
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('foo'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('write:capacity:s-curve'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e:f'));
  });

  it('rejects malformed version suffixes', () => {
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e@1.2'));     // missing patch
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e@v1.2.3'));  // v prefix
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e@1.2.3.4')); // too many parts
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('a:b:c:d:e@'));        // empty version
  });

  it('rejects uppercase, leading digits, and disallowed characters', () => {
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('Wardley:map:value-chain:generate:top-down'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('wardley:map:value-chain:generate:Top-Down'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('1wardley:map:value-chain:generate:top-down'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('wardley:map:value-chain:generate:top_down'));
    assert.ok(!METHOD_ID_5_SEGMENT_REGEX.test('wardley:map:value-chain:generate:'));
  });
});

describe('methodIdSchema (Zod)', () => {
  it('parses valid ids', () => {
    const parsed = methodIdSchema.parse('wardley:map:value-chain:generate:top-down');
    assert.equal(parsed, 'wardley:map:value-chain:generate:top-down');
  });

  it('parses valid ids with version suffix', () => {
    const parsed = methodIdSchema.parse('wardley:map:value-chain:generate:top-down@0.1.0');
    assert.equal(parsed, 'wardley:map:value-chain:generate:top-down@0.1.0');
  });

  it('throws on invalid ids', () => {
    assert.throws(() => methodIdSchema.parse('foo'));
    assert.throws(() => methodIdSchema.parse('write:capacity:s-curve'));
    assert.throws(() => methodIdSchema.parse('Wardley:map:value-chain:generate:top-down'));
    assert.throws(() => methodIdSchema.parse('wardley:map:value-chain:generate:top-down@1.2'));
  });
});
