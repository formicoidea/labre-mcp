import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadToolConfig,
  resolveStrategyForType,
  resetToolConfigCache,
  getLoadedToolConfigPath,
} from './loader.mjs';

const tmpRoot = resolve(tmpdir(), `tool-config-loader-test-${Date.now()}`);

function writeConfig(content: Record<string, unknown>): string {
  const path = resolve(tmpRoot, 'tool.config.json');
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

const VALID_CONFIG = {
  estimateEvolution: {
    auto: {
      anchor: 'anchor-evolution',
      solution: 'write:solution:properties',
      capability: 'write:capacity:s-curve',
    },
    report: {
      anchor: ['anchor-evolution'],
      solution: ['write:solution:properties'],
      capability: ['write:capacity:s-curve', 'write:capacity:publication-analysis'],
    },
  },
};

beforeEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  resetToolConfigCache();
});

afterEach(() => {
  delete process.env.WARDLEY_TOOL_CONFIG;
  resetToolConfigCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadToolConfig', () => {
  it('loads a valid config from the env var path', () => {
    const path = writeConfig(VALID_CONFIG);
    process.env.WARDLEY_TOOL_CONFIG = path;
    const loaded = loadToolConfig();
    assert.equal(loaded.estimateEvolution.auto.capability, 'write:capacity:s-curve');
    assert.deepEqual(loaded.estimateEvolution.report.capability, [
      'write:capacity:s-curve',
      'write:capacity:publication-analysis',
    ]);
    assert.equal(getLoadedToolConfigPath(), path);
  });

  it('caches the result across calls (no re-read from disk)', () => {
    const path = writeConfig(VALID_CONFIG);
    process.env.WARDLEY_TOOL_CONFIG = path;
    const first = loadToolConfig();
    // Mutate file on disk; cached result should not change.
    writeFileSync(path, JSON.stringify({ estimateEvolution: { auto: {}, report: {} } }, null, 2));
    const second = loadToolConfig();
    assert.strictEqual(first, second);
    assert.equal(second.estimateEvolution.auto.capability, 'write:capacity:s-curve');
  });

  it('rejects an invalid capability method id', () => {
    const path = writeConfig({
      estimateEvolution: {
        auto: {
          anchor: 'anchor-evolution',
          solution: 'write:solution:properties',
          capability: 'NOT-A-VALID-ID',
        },
        report: {
          anchor: ['anchor-evolution'],
          solution: ['write:solution:properties'],
          capability: ['write:capacity:s-curve'],
        },
      },
    });
    process.env.WARDLEY_TOOL_CONFIG = path;
    assert.throws(() => loadToolConfig(), /failed validation/i);
  });

  it('rejects a report list with empty array', () => {
    const path = writeConfig({
      estimateEvolution: {
        auto: VALID_CONFIG.estimateEvolution.auto,
        report: {
          anchor: ['anchor-evolution'],
          solution: ['write:solution:properties'],
          capability: [],
        },
      },
    });
    process.env.WARDLEY_TOOL_CONFIG = path;
    assert.throws(() => loadToolConfig(), /failed validation/i);
  });

  it('throws a descriptive error if file is missing', () => {
    process.env.WARDLEY_TOOL_CONFIG = resolve(tmpRoot, 'does-not-exist.json');
    assert.throws(() => loadToolConfig(), /Cannot read tool config/i);
  });

  it('throws a descriptive error if JSON is malformed', () => {
    const path = resolve(tmpRoot, 'tool.config.json');
    writeFileSync(path, '{ not valid json');
    process.env.WARDLEY_TOOL_CONFIG = path;
    assert.throws(() => loadToolConfig(), /Invalid JSON/i);
  });
});

describe('resolveStrategyForType', () => {
  beforeEach(() => {
    const path = writeConfig(VALID_CONFIG);
    process.env.WARDLEY_TOOL_CONFIG = path;
  });

  it('returns a single method id in auto mode', () => {
    assert.equal(resolveStrategyForType('auto', 'capability'), 'write:capacity:s-curve');
    assert.equal(resolveStrategyForType('auto', 'solution'), 'write:solution:properties');
    assert.equal(resolveStrategyForType('auto', 'anchor'), 'anchor-evolution');
  });

  it('returns an array of method ids in report mode', () => {
    const ids = resolveStrategyForType('report', 'capability');
    assert.ok(Array.isArray(ids));
    assert.equal(ids.length, 2);
    assert.deepEqual([...ids], [
      'write:capacity:s-curve',
      'write:capacity:publication-analysis',
    ]);
  });
});
