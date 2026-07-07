import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getPrompt, resetPromptRegistryCache } from './registry.mjs';
import { registerBuilder, resetBuildersRegistry } from './builders-registry.mjs';
import { registerParser, resetParsersRegistry } from './parsers-registry.mjs';
import { resetPromptsConfigCache } from './config.loader.mjs';
import { runWithPromptOverrides, type PromptOverrideStore } from './override-context.mjs';

const tmpRoot = resolve(tmpdir(), `prompts-registry-test-${Date.now()}`);

function setup(config: Record<string, unknown>, templates: Record<string, string> = {}): void {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  for (const [name, content] of Object.entries(templates)) {
    writeFileSync(resolve(tmpRoot, name), content);
  }
  const path = resolve(tmpRoot, 'prompts.config.json');
  writeFileSync(path, JSON.stringify(config));
  process.env.WARDLEY_PROMPTS_CONFIG = path;
}

beforeEach(() => {
  resetPromptRegistryCache();
  resetBuildersRegistry();
  resetParsersRegistry();
  resetPromptsConfigCache();
});

afterEach(() => {
  delete process.env.WARDLEY_PROMPTS_CONFIG;
  resetPromptRegistryCache();
  resetBuildersRegistry();
  resetParsersRegistry();
  resetPromptsConfigCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getPrompt — template + custom parser', () => {
  it('builds via interpolation and parses via registered custom parser', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 't.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'myParser' },
          },
        },
      },
      { 't.md': 'Hello {{name}}!' },
    );
    registerParser('myParser', (response) => response.toUpperCase());

    const p = getPrompt('s');
    assert.deepEqual(p.build({ name: 'world' }), { user: 'Hello world!' });
    assert.equal(p.parse('result'), 'RESULT');
  });

  it('caches resolved prompts across calls', () => {
    setup(
      {
        s: { default: { kind: 'template', templateFile: 't.md', variables: ['x'], parser: { kind: 'custom', id: 'p' } } },
      },
      { 't.md': '{{x}}' },
    );
    registerParser('p', () => null);
    const a = getPrompt('s');
    const b = getPrompt('s');
    assert.strictEqual(a, b);
  });
});

describe('getPrompt — function builder', () => {
  it('invokes the registered builder', () => {
    setup({
      s: { default: { kind: 'function', builderId: 'myBuilder', parser: { kind: 'custom', id: 'p' } } },
    });
    registerBuilder('myBuilder', (ctx) => `built from ${ctx.x}`);
    registerParser('p', () => null);

    const p = getPrompt('s');
    assert.deepEqual(p.build({ x: 42 }), { user: 'built from 42' });
  });

  it('accepts a builder that returns a { system, user } object', () => {
    setup({
      s: { default: { kind: 'function', builderId: 'splitBuilder', parser: { kind: 'custom', id: 'p' } } },
    });
    registerBuilder('splitBuilder', (ctx) => ({
      system: 'You are a test assistant.',
      user: `value=${ctx.value}`,
    }));
    registerParser('p', () => null);

    const p = getPrompt('s');
    assert.deepEqual(p.build({ value: 'abc' }), {
      system: 'You are a test assistant.',
      user: 'value=abc',
    });
  });

  it('throws when a builder returns an invalid shape', () => {
    setup({
      s: { default: { kind: 'function', builderId: 'badBuilder', parser: { kind: 'custom', id: 'p' } } },
    });
    // any: intentionally returning a non-conforming shape to exercise validation.
    registerBuilder('badBuilder', (() => ({ oops: true })) as any);
    registerParser('p', () => null);

    const p = getPrompt('s');
    assert.throws(() => p.build({}), /returned an invalid shape/);
  });
});

describe('getPrompt — split template (system + user)', () => {
  it('loads split template and emits both system and user on build', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: { system: 'sys.md', user: 'user.md' },
            variables: ['name'],
            parser: { kind: 'custom', id: 'p' },
          },
        },
      },
      {
        'sys.md': 'You are an assistant. Output format: UPPER.',
        'user.md': 'Name: {{name}}',
      },
    );
    registerParser('p', () => null);

    const p = getPrompt('s');
    assert.deepEqual(p.build({ name: 'alice' }), {
      system: 'You are an assistant. Output format: UPPER.',
      user: 'Name: alice',
    });
  });

  it('rejects a split template whose system file contains placeholders', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: { system: 'sys.md', user: 'user.md' },
            variables: ['name'],
            parser: { kind: 'custom', id: 'p' },
          },
        },
      },
      {
        'sys.md': 'Hello {{name}}, you are an assistant.',
        'user.md': 'Name: {{name}}',
      },
    );
    registerParser('p', () => null);

    assert.throws(
      () => getPrompt('s'),
      /system file must not contain \{\{\.\.\.\}\} placeholders/,
    );
  });
});

describe('getPrompt — delimited parser', () => {
  it('extracts content between markers', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 't.md',
            variables: [],
            parser: { kind: 'delimited', startMarker: 'START', endMarker: 'END' },
          },
        },
      },
      { 't.md': 'no vars' },
    );

    const p = getPrompt('s');
    assert.equal(p.parse('prose\nSTART\nthe content\nEND\ntail'), 'the content');
  });
});

describe('getPrompt — error paths', () => {
  it('throws when strategy is unknown', () => {
    setup({
      s: { default: { kind: 'function', builderId: 'b', parser: { kind: 'custom', id: 'p' } } },
    });
    registerBuilder('b', () => '');
    registerParser('p', () => null);
    assert.throws(() => getPrompt('unknown'), /not found/);
  });

  it('throws when prompt name is unknown for a known strategy', () => {
    setup({
      s: { default: { kind: 'function', builderId: 'b', parser: { kind: 'custom', id: 'p' } } },
    });
    registerBuilder('b', () => '');
    registerParser('p', () => null);
    assert.throws(() => getPrompt('s', 'other'), /not found/);
  });

  it('throws when a function-kind entry references an unregistered builder', () => {
    setup({
      s: { default: { kind: 'function', builderId: 'ghost', parser: { kind: 'custom', id: 'p' } } },
    });
    registerParser('p', () => null);
    assert.throws(() => getPrompt('s'), /builder "ghost" is not registered/);
  });

  it('throws on .parse() when a custom parser is unregistered (lazy)', () => {
    setup(
      { s: { default: { kind: 'template', templateFile: 't.md', variables: [], parser: { kind: 'custom', id: 'ghost' } } } },
      { 't.md': 'x' },
    );
    const p = getPrompt('s');  // build() does not require parser registration
    assert.deepEqual(p.build({}), { user: 'x' });
    assert.throws(() => p.parse('response'), /parser "ghost" is not registered/);
  });

  it('rejects keyValue parser kind on .parse() until schema registry is wired', () => {
    setup(
      { s: { default: { kind: 'template', templateFile: 't.md', variables: [], parser: { kind: 'keyValue', schemaId: 'X' } } } },
      { 't.md': 'x' },
    );
    const p = getPrompt('s');
    assert.throws(() => p.parse('response'), /not yet wired/);
  });
});

describe('getPrompt — run-scoped prompt overrides', () => {
  function overrideStore(user: string): PromptOverrideStore {
    return { prompts: { s: { default: { system: 'OVERRIDE SYSTEM', user } } } };
  }

  it('returns bundle text on build() and the SHIPPED parser on parse()', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 't.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'shippedParser' },
          },
        },
      },
      { 't.md': 'Shipped hello {{name}}' },
    );
    registerParser('shippedParser', (response) => `parsed:${response}`);

    runWithPromptOverrides(overrideStore('Override hi {{name}}'), () => {
      const p = getPrompt('s');
      // build() uses the bundle's user text + verbatim system, not the shipped template.
      assert.deepEqual(p.build({ name: 'bob' }), {
        system: 'OVERRIDE SYSTEM',
        user: 'Override hi bob',
      });
      // parse() still resolves the shipped parser id.
      assert.equal(p.parse('x'), 'parsed:x');
    });
  });

  it('does not poison the global cache — shipped content after the run', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 't.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'p' },
          },
        },
      },
      { 't.md': 'Shipped {{name}}' },
    );
    registerParser('p', () => null);

    runWithPromptOverrides(overrideStore('Override {{name}}'), () => {
      assert.deepEqual(getPrompt('s').build({ name: 'x' }), {
        system: 'OVERRIDE SYSTEM',
        user: 'Override x',
      });
    });

    // Same key resolved OUTSIDE the ALS run must yield the shipped content.
    assert.deepEqual(getPrompt('s').build({ name: 'x' }), { user: 'Shipped x' });
  });

  it('throws not-found when an override has no shipped entry (parser trust boundary)', () => {
    setup({
      s: { default: { kind: 'function', builderId: 'b', parser: { kind: 'custom', id: 'p' } } },
    });
    registerBuilder('b', () => '');
    registerParser('p', () => null);

    const store: PromptOverrideStore = {
      prompts: { s: { ghost: { system: 'sys', user: 'u' } } },
    };
    runWithPromptOverrides(store, () => {
      assert.throws(() => getPrompt('s', 'ghost'), /not found/);
    });
  });

  it('leaves the shipped path byte-identical when no override matches', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 't.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'p' },
          },
        },
      },
      { 't.md': 'Shipped {{name}}' },
    );
    registerParser('p', () => null);

    // Override present for a DIFFERENT strategy → no match → shipped resolution.
    const store: PromptOverrideStore = {
      prompts: { other: { default: { system: 's', user: 'u' } } },
    };
    runWithPromptOverrides(store, () => {
      assert.deepEqual(getPrompt('s').build({ name: 'x' }), { user: 'Shipped x' });
    });
  });
});

describe('getPrompt — prompt-experiment variant substitution', () => {
  it('substitutes the default prompt with a SHIPPED variant when a variant is active', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 'default.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'defaultParser' },
          },
          'variant-b': {
            kind: 'template',
            templateFile: 'variant.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'variantParser' },
          },
        },
      },
      { 'default.md': 'Default {{name}}', 'variant.md': 'Variant {{name}}' },
    );
    registerParser('defaultParser', () => 'default');
    registerParser('variantParser', () => 'variant');

    const store: PromptOverrideStore = {
      prompts: {},
      activeVariants: { s: 'variant-b' },
    };
    runWithPromptOverrides(store, () => {
      // Asking for 'default' redirects to the shipped variant text + parser.
      const p = getPrompt('s');
      assert.deepEqual(p.build({ name: 'x' }), { user: 'Variant x' });
      assert.equal(p.parse('anything'), 'variant');
    });
  });

  it('substitutes the default prompt with a BUNDLE-OVERRIDE variant', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 'default.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'defaultParser' },
          },
          'variant-b': {
            kind: 'template',
            templateFile: 'variant.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'variantParser' },
          },
        },
      },
      { 'default.md': 'Default {{name}}', 'variant.md': 'Shipped variant {{name}}' },
    );
    registerParser('defaultParser', () => 'default');
    registerParser('variantParser', (response) => `variant-parsed:${response}`);

    // The active variant has a bundle-override pair AND a shipped entry; the
    // override pair wins for the TEXT, the shipped variant entry supplies the
    // parser (trust boundary: a bundle never selects a parser id).
    const store: PromptOverrideStore = {
      prompts: { s: { 'variant-b': { system: 'VARIANT OVERRIDE SYSTEM', user: 'Override variant {{name}}' } } },
      activeVariants: { s: 'variant-b' },
    };
    runWithPromptOverrides(store, () => {
      const p = getPrompt('s');
      assert.deepEqual(p.build({ name: 'x' }), {
        system: 'VARIANT OVERRIDE SYSTEM',
        user: 'Override variant x',
      });
      assert.equal(p.parse('r'), 'variant-parsed:r');
    });
  });

  it('falls back to the default prompt when the variant name resolves nowhere', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 'default.md',
            variables: ['name'],
            parser: { kind: 'custom', id: 'defaultParser' },
          },
        },
      },
      { 'default.md': 'Default {{name}}' },
    );
    registerParser('defaultParser', () => 'default');

    // Variant flag names a prompt that exists neither as a bundle override nor a
    // shipped entry → fail-safe fallback to 'default'.
    const store: PromptOverrideStore = {
      prompts: {},
      activeVariants: { s: 'ghost-variant' },
    };
    runWithPromptOverrides(store, () => {
      const p = getPrompt('s');
      assert.deepEqual(p.build({ name: 'x' }), { user: 'Default x' });
      assert.equal(p.parse('anything'), 'default');
    });
  });

  it('does not substitute explicit non-default names', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 'default.md',
            variables: [],
            parser: { kind: 'custom', id: 'p' },
          },
          'pick-class': {
            kind: 'template',
            templateFile: 'pick.md',
            variables: [],
            parser: { kind: 'custom', id: 'p' },
          },
          'variant-b': {
            kind: 'template',
            templateFile: 'variant.md',
            variables: [],
            parser: { kind: 'custom', id: 'p' },
          },
        },
      },
      { 'default.md': 'DEFAULT', 'pick.md': 'PICK', 'variant.md': 'VARIANT' },
    );
    registerParser('p', () => null);

    const store: PromptOverrideStore = {
      prompts: {},
      activeVariants: { s: 'variant-b' },
    };
    runWithPromptOverrides(store, () => {
      // An explicit non-default name is NOT redirected by an active variant.
      assert.deepEqual(getPrompt('s', 'pick-class').build({}), { user: 'PICK' });
      // The default IS redirected to the variant, confirming the variant is active.
      assert.deepEqual(getPrompt('s').build({}), { user: 'VARIANT' });
    });
  });

  it('caches the variant under its own key without contaminating the default key', () => {
    setup(
      {
        s: {
          default: {
            kind: 'template',
            templateFile: 'default.md',
            variables: [],
            parser: { kind: 'custom', id: 'p' },
          },
          'variant-b': {
            kind: 'template',
            templateFile: 'variant.md',
            variables: [],
            parser: { kind: 'custom', id: 'p' },
          },
        },
      },
      { 'default.md': 'DEFAULT', 'variant.md': 'VARIANT' },
    );
    registerParser('p', () => null);

    // Resolve the variant inside a variant-active run (caches under s:variant-b).
    const store: PromptOverrideStore = {
      prompts: {},
      activeVariants: { s: 'variant-b' },
    };
    runWithPromptOverrides(store, () => {
      assert.deepEqual(getPrompt('s').build({}), { user: 'VARIANT' });
    });

    // OUTSIDE any variant run, the default key must still yield shipped default
    // content — the variant caching never poisoned s:default.
    assert.deepEqual(getPrompt('s').build({}), { user: 'DEFAULT' });
    // And the explicit variant name still resolves to variant content (cached).
    assert.deepEqual(getPrompt('s', 'variant-b').build({}), { user: 'VARIANT' });
  });
});

describe('builders-registry / parsers-registry', () => {
  it('rejects double-registration with a helpful message', () => {
    registerBuilder('dup', () => '');
    assert.throws(() => registerBuilder('dup', () => ''), /already registered/);
    registerParser('dup', () => null);
    assert.throws(() => registerParser('dup', () => null), /already registered/);
  });
});
