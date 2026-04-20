import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPromptsConfig, resetPromptsConfigCache } from './config.loader.mjs';

const tmpRoot = resolve(tmpdir(), `prompts-loader-test-${Date.now()}`);

function writeConfig(content: Record<string, unknown>, dir = tmpRoot): string {
  const path = resolve(dir, 'prompts.config.json');
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

function writeTemplate(filename: string, content: string, dir = tmpRoot): void {
  writeFileSync(resolve(dir, filename), content);
}

beforeEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  resetPromptsConfigCache();
});

afterEach(() => {
  delete process.env.WARDLEY_PROMPTS_CONFIG;
  resetPromptsConfigCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadPromptsConfig', () => {
  it('loads a valid config with one template prompt', () => {
    writeTemplate('t.md', 'Hello {{name}}!');
    const path = writeConfig({
      'my-strategy': {
        default: {
          kind: 'template',
          templateFile: 't.md',
          variables: ['name'],
          parser: { kind: 'custom', id: 'myParser' },
        },
      },
    });
    process.env.WARDLEY_PROMPTS_CONFIG = path;
    const loaded = loadPromptsConfig();
    assert.equal(loaded.templates['my-strategy'].default.text, 'Hello {{name}}!');
    assert.deepEqual(loaded.templates['my-strategy'].default.variables, ['name']);
  });

  it('normalizes CRLF line endings to LF', () => {
    writeTemplate('t.md', 'line1\r\nline2\r\n{{x}}');
    const path = writeConfig({
      s: {
        default: {
          kind: 'template',
          templateFile: 't.md',
          variables: ['x'],
          parser: { kind: 'custom', id: 'p' },
        },
      },
    });
    process.env.WARDLEY_PROMPTS_CONFIG = path;
    const loaded = loadPromptsConfig();
    assert.equal(loaded.templates.s.default.text, 'line1\nline2\n{{x}}');
  });

  it('rejects a template with variables[] that mismatch the template placeholders', () => {
    writeTemplate('t.md', 'Hello {{name}} and {{missing}}');
    const path = writeConfig({
      s: {
        default: {
          kind: 'template',
          templateFile: 't.md',
          variables: ['name'], // missing declares one fewer
          parser: { kind: 'custom', id: 'p' },
        },
      },
    });
    process.env.WARDLEY_PROMPTS_CONFIG = path;
    assert.throws(() => loadPromptsConfig(), /not declared in variables/);
  });

  it('rejects a template with extra declared variables not used', () => {
    writeTemplate('t.md', 'Hello {{name}}');
    const path = writeConfig({
      s: {
        default: {
          kind: 'template',
          templateFile: 't.md',
          variables: ['name', 'unused'],
          parser: { kind: 'custom', id: 'p' },
        },
      },
    });
    process.env.WARDLEY_PROMPTS_CONFIG = path;
    assert.throws(() => loadPromptsConfig(), /not used in template/);
  });

  it('rejects invalid JSON', () => {
    const path = resolve(tmpRoot, 'prompts.config.json');
    writeFileSync(path, '{ not valid json');
    process.env.WARDLEY_PROMPTS_CONFIG = path;
    assert.throws(() => loadPromptsConfig(), /Invalid JSON/);
  });

  it('rejects config that fails schema validation', () => {
    const path = writeConfig({
      s: { default: { kind: 'template' /* missing required fields */ } },
    });
    process.env.WARDLEY_PROMPTS_CONFIG = path;
    assert.throws(() => loadPromptsConfig(), /failed validation/);
  });

  it('accepts function-kind prompts without reading a template', () => {
    const path = writeConfig({
      s: {
        default: {
          kind: 'function',
          builderId: 'myBuilder',
          parser: { kind: 'custom', id: 'p' },
        },
      },
    });
    process.env.WARDLEY_PROMPTS_CONFIG = path;
    const loaded = loadPromptsConfig();
    assert.equal(loaded.templates.s.default, undefined);
    assert.equal(loaded.config.s.default.kind, 'function');
  });

  it('caches across calls', () => {
    writeTemplate('t.md', '{{x}}');
    const path = writeConfig({
      s: { default: { kind: 'template', templateFile: 't.md', variables: ['x'], parser: { kind: 'custom', id: 'p' } } },
    });
    process.env.WARDLEY_PROMPTS_CONFIG = path;
    const a = loadPromptsConfig();
    const b = loadPromptsConfig();
    assert.strictEqual(a, b);
  });
});
