import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLLMConfig, resetLLMConfigCache } from './config.loader.mjs';

let dir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-config-'));
  originalEnv = process.env.WARDLEY_LLM_CONFIG;
  resetLLMConfigCache();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.WARDLEY_LLM_CONFIG;
  else process.env.WARDLEY_LLM_CONFIG = originalEnv;
  rmSync(dir, { recursive: true, force: true });
  resetLLMConfigCache();
});

function writeConfig(content: unknown): string {
  const path = join(dir, 'llm.config.json');
  writeFileSync(path, JSON.stringify(content));
  process.env.WARDLEY_LLM_CONFIG = path;
  return path;
}

describe('loadLLMConfig', () => {
  it('parses a valid config', () => {
    writeConfig({
      defaultProvider: 'claude-sdk',
      providers: { 'claude-sdk': { kind: 'agent-sdk' } },
      strategies: {
        'publication-analysis': { provider: 'claude-sdk', model: 'claude-sonnet-4-6' },
      },
    });
    const cfg = loadLLMConfig();
    assert.equal(cfg.defaultProvider, 'claude-sdk');
    assert.equal(cfg.strategies['publication-analysis'].model, 'claude-sonnet-4-6');
  });

  it('rejects a config whose defaultProvider is not declared', () => {
    writeConfig({
      defaultProvider: 'ghost',
      providers: { 'claude-sdk': { kind: 'agent-sdk' } },
      strategies: {},
    });
    assert.throws(() => loadLLMConfig(), /defaultProvider "ghost" is not declared/);
  });

  it('rejects a strategy referencing an unknown provider', () => {
    writeConfig({
      defaultProvider: 'claude-sdk',
      providers: { 'claude-sdk': { kind: 'agent-sdk' } },
      strategies: {
        'bad-one': { provider: 'missing', model: 'x' },
      },
    });
    assert.throws(() => loadLLMConfig(), /Strategy "bad-one" references unknown provider "missing"/);
  });

  it('rejects a provider with an unsupported kind', () => {
    writeConfig({
      defaultProvider: 'x',
      providers: { x: { kind: 'nonexistent-kind' } },
      strategies: {},
    });
    assert.throws(() => loadLLMConfig(), /failed validation/);
  });

  it('accepts a copilot-sdk provider with authEnv', () => {
    writeConfig({
      defaultProvider: 'claude-sdk',
      providers: {
        'claude-sdk': { kind: 'agent-sdk' },
        copilot: { kind: 'copilot-sdk', authEnv: 'COPILOT_GITHUB_TOKEN' },
      },
      strategies: {},
    });
    const cfg = loadLLMConfig();
    assert.equal(cfg.providers.copilot.kind, 'copilot-sdk');
    assert.equal(cfg.providers.copilot.authEnv, 'COPILOT_GITHUB_TOKEN');
  });

  it('memoizes across calls within a process', () => {
    writeConfig({
      defaultProvider: 'claude-sdk',
      providers: { 'claude-sdk': { kind: 'agent-sdk' } },
      strategies: {},
    });
    const a = loadLLMConfig();
    const b = loadLLMConfig();
    assert.equal(a, b);
  });

  it('throws a clear error when the file does not exist', () => {
    process.env.WARDLEY_LLM_CONFIG = join(dir, 'missing.json');
    assert.throws(() => loadLLMConfig(), /Cannot read LLM config/);
  });
});
