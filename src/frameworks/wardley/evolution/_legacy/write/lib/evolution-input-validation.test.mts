// Tests for evolution-input-validation.mjs
// Co-located with source — validates validateOneShotInput, resolveClassification, VALID_SPACES

import assert from 'node:assert/strict';
import { validateOneShotInput, resolveClassification, VALID_SPACES } from './evolution-input-validation.mjs';

// ─── VALID_SPACES ───────────────────────────────────────────────────────────

assert.deepStrictEqual(VALID_SPACES, ['economic', 'social_good', 'common_good'],
  'VALID_SPACES should contain the three canonical spaces');

// ─── validateOneShotInput ───────────────────────────────────────────────────

// Rejects null/undefined/non-object (Zod "invalid_type" issues)
assert.throws(() => validateOneShotInput(null), /invalid_type|object/i);
assert.throws(() => validateOneShotInput(undefined), /invalid_type|object/i);
assert.throws(() => validateOneShotInput('string'), /invalid_type|object/i);

// Rejects missing or empty name
assert.throws(() => validateOneShotInput({}), /name/);
assert.throws(() => validateOneShotInput({ name: '' }), /name/);

// Accepts valid minimal input
const minimal = validateOneShotInput({ name: 'Docker' });
assert.strictEqual(minimal.name, 'Docker');
assert.strictEqual(minimal.strategy, 'auto');
assert.strictEqual(minimal.space, undefined);

// Validates space — accepts canonical lowercase values
const eco = validateOneShotInput({ name: 'X', space: 'economic' });
assert.strictEqual(eco.space, 'economic');

const social = validateOneShotInput({ name: 'X', space: 'social_good' });
assert.strictEqual(social.space, 'social_good');

// Rejects invalid space (Zod enum mismatch)
assert.throws(() => validateOneShotInput({ name: 'X', space: 'invalid' }), /invalid_value|invalid_enum/i);

// Validates numeric fields in [0, 1]
const withNumerics = validateOneShotInput({ name: 'X', certitude: 0.5, ubiquity: 1 });
assert.strictEqual(withNumerics.certitude, 0.5);
assert.strictEqual(withNumerics.ubiquity, 1);

assert.throws(() => validateOneShotInput({ name: 'X', certitude: -0.1 }), /too_small|0/);
assert.throws(() => validateOneShotInput({ name: 'X', ubiquity: 1.5 }), /too_big|1/);
assert.throws(() => validateOneShotInput({ name: 'X', certitude: 'high' }), /invalid_type|number/i);

// Rejects non-string description (Zod invalid_type)
assert.throws(() => validateOneShotInput({ name: 'X', description: 42 }), /invalid_type|string/i);

// Pipeline flag passes through when boolean
const withPipeline = validateOneShotInput({ name: 'X', pipeline: true });
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
