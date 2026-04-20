import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getPrompt, resetPromptRegistryCache } from './registry.mjs';
import { registerBuilder, resetBuildersRegistry } from './builders-registry.mjs';
import { registerParser, resetParsersRegistry } from './parsers-registry.mjs';
import { resetPromptsConfigCache } from './config.loader.mjs';

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
    assert.equal(p.build({ name: 'world' }), 'Hello world!');
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
    assert.equal(p.build({ x: 42 }), 'built from 42');
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
    assert.equal(p.build({}), 'x');
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

describe('builders-registry / parsers-registry', () => {
  it('rejects double-registration with a helpful message', () => {
    registerBuilder('dup', () => '');
    assert.throws(() => registerBuilder('dup', () => ''), /already registered/);
    registerParser('dup', () => null);
    assert.throws(() => registerParser('dup', () => null), /already registered/);
  });
});
