// Tests for evolution-input-validation.mjs
// Co-located with source — validates validateOneShotInput, resolveClassification, VALID_SPACES

import assert from 'node:assert/strict';
import { validateOneShotInput, resolveClassification, VALID_SPACES } from './evolution-input-validation.mjs';

// ─── VALID_SPACES ───────────────────────────────────────────────────────────

assert.deepStrictEqual(VALID_SPACES, ['economic', 'social_good', 'common_good'],
  'VALID_SPACES should contain the three canonical spaces');

// ─── validateOneShotInput ───────────────────────────────────────────────────

// Rejects null/undefined/non-object
assert.throws(() => validateOneShotInput(null), /non-null object/);
assert.throws(() => validateOneShotInput(undefined), /non-null object/);
assert.throws(() => validateOneShotInput('string'), /non-null object/);

// Rejects missing or empty name
assert.throws(() => validateOneShotInput({}), /name/);
assert.throws(() => validateOneShotInput({ name: '' }), /name/);
assert.throws(() => validateOneShotInput({ name: '   ' }), /name/);

// Accepts valid minimal input
const minimal = validateOneShotInput({ name: 'Docker' });
assert.strictEqual(minimal.name, 'Docker');
assert.strictEqual(minimal.description, '');
assert.strictEqual(minimal.strategy, 'all');
assert.strictEqual(minimal.space, undefined);

// Trims name and description
const trimmed = validateOneShotInput({ name: '  Docker  ', description: '  container runtime  ' });
assert.strictEqual(trimmed.name, 'Docker');
assert.strictEqual(trimmed.description, 'container runtime');

// Validates space — accepts valid values (case-insensitive)
const eco = validateOneShotInput({ name: 'X', space: 'Economic' });
assert.strictEqual(eco.space, 'economic');

const social = validateOneShotInput({ name: 'X', space: 'SOCIAL_GOOD' });
assert.strictEqual(social.space, 'social_good');

// Rejects invalid space
assert.throws(() => validateOneShotInput({ name: 'X', space: 'invalid' }), /must be one of/);

// Validates numeric fields in [0, 1]
const withNumerics = validateOneShotInput({ name: 'X', certitude: 0.5, ubiquity: 1 });
assert.strictEqual(withNumerics.certitude, 0.5);
assert.strictEqual(withNumerics.ubiquity, 1);

assert.throws(() => validateOneShotInput({ name: 'X', certitude: -0.1 }), /between 0 and 1/);
assert.throws(() => validateOneShotInput({ name: 'X', ubiquity: 1.5 }), /between 0 and 1/);
assert.throws(() => validateOneShotInput({ name: 'X', wonder: 'high' }), /must be a number/);

// Rejects non-string description
assert.throws(() => validateOneShotInput({ name: 'X', description: 42 }), /must be a string/);

// Pipeline flag is boolean-coerced
const withPipeline = validateOneShotInput({ name: 'X', pipeline: 1 });
assert.strictEqual(withPipeline.pipeline, true);

// ─── resolveClassification ──────────────────────────────────────────────────

// Pre-classified economic
const ecoClass = resolveClassification('Docker', 'container', 'economic');
assert.strictEqual(ecoClass.space, 'economic');
assert.strictEqual(ecoClass.requiresReQuestion, false);
assert.ok(ecoClass.reason.includes('pre-classified'));

// Pre-classified social_good
const socialClass = resolveClassification('Water', 'natural resource', 'social_good');
assert.strictEqual(socialClass.space, 'social_good');
assert.strictEqual(socialClass.requiresReQuestion, true);

// Pre-classified common_good
const commonClass = resolveClassification('Air', 'atmosphere', 'common_good');
assert.strictEqual(commonClass.space, 'common_good');
assert.strictEqual(commonClass.requiresReQuestion, true);

// Auto-detect (no space) — delegates to classifyComponent
const autoClass = resolveClassification('Docker', 'container runtime', undefined);
assert.ok(autoClass.space, 'Auto-classification should return a space');
assert.ok(typeof autoClass.reason === 'string', 'Should have a reason string');

console.log('evolution-input-validation.test.mjs: all tests passed');
