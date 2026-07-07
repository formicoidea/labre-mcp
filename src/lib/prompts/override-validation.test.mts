import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBundlePromptsOverridable } from './override-validation.mjs';
import { resetPromptsConfigCache } from './config.loader.mjs';
import type { BundlePromptPair } from './override-context.mjs';

// A self-contained prompts.config.json with one template-kind entry and one
// function-kind entry. Pointed at via WARDLEY_PROMPTS_CONFIG so the check runs
// against a known corpus rather than the shipped one (which has no function
// entries to exercise the "not overridable" branch). The template file is
// written to disk because loadPromptsConfig() eagerly resolves every
// template-kind entry's content at load time.
const CONFIG = {
  'tpl-strategy': {
    default: {
      kind: 'template',
      templateFile: 'tpl.md',
      variables: [],
      parser: { kind: 'custom', id: 'noop' },
    },
  },
  'fn-strategy': {
    default: {
      kind: 'function',
      builderId: 'some-builder',
      parser: { kind: 'custom', id: 'noop' },
    },
  },
};

const pair: BundlePromptPair = { system: 'sys', user: 'hi' };

describe('override-validation — assertBundlePromptsOverridable', () => {
  let prevEnv: string | undefined;

  before(async () => {
    prevEnv = process.env.WARDLEY_PROMPTS_CONFIG;
    const dir = await mkdtemp(join(tmpdir(), 'labre-prompts-'));
    const path = join(dir, 'prompts.config.json');
    await writeFile(path, JSON.stringify(CONFIG), 'utf8');
    // Template-kind entries are eagerly resolved at load — the file must exist
    // and (variables: []) carry no {{...}} placeholders.
    await writeFile(join(dir, 'tpl.md'), 'A constant template with no placeholders.\n', 'utf8');
    process.env.WARDLEY_PROMPTS_CONFIG = path;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.WARDLEY_PROMPTS_CONFIG;
    else process.env.WARDLEY_PROMPTS_CONFIG = prevEnv;
    resetPromptsConfigCache();
  });

  beforeEach(() => {
    resetPromptsConfigCache();
  });

  it('accepts an override targeting a shipped template prompt', () => {
    assert.doesNotThrow(() =>
      assertBundlePromptsOverridable({ 'tpl-strategy': { default: pair } }, 'good-bundle'),
    );
  });

  it('accepts an empty prompts map (no overrides declared)', () => {
    assert.doesNotThrow(() => assertBundlePromptsOverridable({}, 'no-prompts-bundle'));
  });

  it('rejects an override targeting an unknown prompt (naming bundle + pair)', () => {
    assert.throws(
      () => assertBundlePromptsOverridable({ 'tpl-strategy': { nope: pair } }, 'bad-bundle'),
      (err: Error) => {
        assert.match(err.message, /bad-bundle/);
        assert.match(err.message, /tpl-strategy\/nope/);
        assert.match(err.message, /unknown shipped prompt/);
        return true;
      },
    );
  });

  it('rejects an override targeting an unknown strategy id', () => {
    assert.throws(
      () => assertBundlePromptsOverridable({ 'ghost-strategy': { default: pair } }, 'bad-bundle'),
      /ghost-strategy\/default.*unknown shipped prompt/s,
    );
  });

  it('rejects an override targeting a function-kind prompt (not overridable)', () => {
    assert.throws(
      () => assertBundlePromptsOverridable({ 'fn-strategy': { default: pair } }, 'fn-bundle'),
      (err: Error) => {
        assert.match(err.message, /fn-bundle/);
        assert.match(err.message, /fn-strategy\/default/);
        assert.match(err.message, /"function"-kind/);
        assert.match(err.message, /not overridable/);
        return true;
      },
    );
  });
});
