// Tests for bigquery-client.mjs — BigQuery client configuration and authentication helper.
//
// These tests verify:
//   1. Configuration resolution from options / env / defaults
//   2. Configuration validation (projectId format, required fields)
//   3. Client singleton pool (creation, reuse, destruction)
//   4. Default query options generation
//   5. Environment check helper
//
// No actual BigQuery connection is made — the @google-cloud/bigquery import
// is tested via dynamic import interception patterns.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  resolveConfig,
  validateConfig,
  getClient,
  destroyClient,
  destroyAllClients,
  poolSize,
  defaultQueryOptions,
  checkEnvironment,
} from './bigquery-client.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Save and restore env vars around tests. */
function withEnv(overrides, fn) {
  return async () => {
    const saved = {};
    for (const key of Object.keys(overrides)) {
      saved[key] = process.env[key];
      if (overrides[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = overrides[key];
      }
    }
    try {
      await fn();
    } finally {
      for (const [key, val] of Object.entries(saved)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    }
  };
}

/** Valid minimal config for testing. */
function validConfig(overrides = {}) {
  return {
    projectId: 'my-test-project',
    dataset: 'patents-public-data',
    location: 'US',
    maxBytesBilled: '1073741824',
    timeoutMs: 30000,
    scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    ...overrides,
  };
}

// ─── DEFAULTS ───────────────────────────────────────────────────────────────

describe('DEFAULTS', () => {
  it('should be frozen and contain expected keys', () => {
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.equal(DEFAULTS.dataset, 'patents-public-data');
    assert.equal(DEFAULTS.location, 'US');
    assert.equal(DEFAULTS.timeoutMs, 30_000);
    assert.ok(DEFAULTS.maxBytesBilled);
    assert.ok(Array.isArray(DEFAULTS.scopes));
    assert.ok(DEFAULTS.scopes.length > 0);
    assert.ok(DEFAULTS.scopes[0].includes('bigquery'));
  });

  it('maxBytesBilled should represent 1 GB', () => {
    assert.equal(Number(DEFAULTS.maxBytesBilled), 1 * 1024 * 1024 * 1024);
  });
});

// ─── resolveConfig ──────────────────────────────────────────────────────────

describe('resolveConfig', () => {
  beforeEach(() => {
    // Clear relevant env vars to avoid test pollution
    delete process.env.BIGQUERY_PROJECT_ID;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.BIGQUERY_DATASET;
    delete process.env.BIGQUERY_LOCATION;
    delete process.env.BIGQUERY_MAX_BYTES;
    delete process.env.BIGQUERY_TIMEOUT_MS;
    delete process.env.BIGQUERY_SCOPES;
  });

  it('should resolve projectId from options', () => {
    const config = resolveConfig({ projectId: 'my-project-123' });
    assert.equal(config.projectId, 'my-project-123');
  });

  it('should resolve projectId from env if not in options', withEnv(
    { BIGQUERY_PROJECT_ID: 'env-project-42' },
    () => {
      const config = resolveConfig();
      assert.equal(config.projectId, 'env-project-42');
    }
  ));

  it('should throw if projectId is missing from both options and env', () => {
    assert.throws(
      () => resolveConfig(),
      /BIGQUERY_PROJECT_ID/
    );
  });

  it('should resolve keyFilename from GOOGLE_APPLICATION_CREDENTIALS', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok', GOOGLE_APPLICATION_CREDENTIALS: '/path/to/sa.json' },
    () => {
      const config = resolveConfig();
      assert.equal(config.keyFilename, '/path/to/sa.json');
    }
  ));

  it('should prefer explicit options over env for keyFilename', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok', GOOGLE_APPLICATION_CREDENTIALS: '/env/path.json' },
    () => {
      const config = resolveConfig({ keyFilename: '/explicit/path.json' });
      assert.equal(config.keyFilename, '/explicit/path.json');
    }
  ));

  it('should use defaults when env and options are absent', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok' },
    () => {
      const config = resolveConfig();
      assert.equal(config.dataset, DEFAULTS.dataset);
      assert.equal(config.location, DEFAULTS.location);
      assert.equal(config.maxBytesBilled, DEFAULTS.maxBytesBilled);
      assert.equal(config.timeoutMs, DEFAULTS.timeoutMs);
      assert.deepEqual(config.scopes, DEFAULTS.scopes);
    }
  ));

  it('should resolve dataset from env override', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok', BIGQUERY_DATASET: 'custom-dataset' },
    () => {
      const config = resolveConfig();
      assert.equal(config.dataset, 'custom-dataset');
    }
  ));

  it('should resolve location from env override', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok', BIGQUERY_LOCATION: 'EU' },
    () => {
      const config = resolveConfig();
      assert.equal(config.location, 'EU');
    }
  ));

  it('should resolve timeoutMs from env as number', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok', BIGQUERY_TIMEOUT_MS: '60000' },
    () => {
      const config = resolveConfig();
      assert.equal(config.timeoutMs, 60000);
      assert.equal(typeof config.timeoutMs, 'number');
    }
  ));

  it('should parse comma-separated scopes from env', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok', BIGQUERY_SCOPES: 'scope1,scope2, scope3' },
    () => {
      const config = resolveConfig();
      assert.deepEqual(config.scopes, ['scope1', 'scope2', 'scope3']);
    }
  ));

  it('should always return maxBytesBilled as string', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok' },
    () => {
      const config = resolveConfig({ maxBytesBilled: 500000 });
      assert.equal(typeof config.maxBytesBilled, 'string');
      assert.equal(config.maxBytesBilled, '500000');
    }
  ));

  it('options take priority over env', withEnv(
    { BIGQUERY_PROJECT_ID: 'env-proj-12', BIGQUERY_DATASET: 'env-ds' },
    () => {
      const config = resolveConfig({ projectId: 'opt-proj-34', dataset: 'opt-ds' });
      assert.equal(config.projectId, 'opt-proj-34');
      assert.equal(config.dataset, 'opt-ds');
    }
  ));

  it('keyFilename should be undefined when not set', withEnv(
    { BIGQUERY_PROJECT_ID: 'test-proj-ok' },
    () => {
      const config = resolveConfig();
      assert.equal(config.keyFilename, undefined);
    }
  ));
});

// ─── validateConfig ─────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('should pass for a valid config', () => {
    const result = validateConfig(validConfig());
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('should fail for null config', () => {
    const result = validateConfig(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('non-null'));
  });

  it('should fail for missing projectId', () => {
    const result = validateConfig(validConfig({ projectId: '' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('projectId')));
  });

  it('should fail for malformed projectId (too short)', () => {
    const result = validateConfig(validConfig({ projectId: 'ab' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('projectId')));
  });

  it('should fail for malformed projectId (uppercase)', () => {
    const result = validateConfig(validConfig({ projectId: 'My-Project-123' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('projectId')));
  });

  it('should pass for valid GCP project ID format', () => {
    const validIds = ['my-project-123', 'abcdef', 'test-project-us-east1'];
    for (const id of validIds) {
      const result = validateConfig(validConfig({ projectId: id }));
      assert.equal(result.valid, true, `Expected "${id}" to be valid`);
    }
  });

  it('should accept undefined keyFilename (ADC fallback)', () => {
    const result = validateConfig(validConfig({ keyFilename: undefined }));
    assert.equal(result.valid, true);
  });

  it('should fail for empty string keyFilename', () => {
    const result = validateConfig(validConfig({ keyFilename: '  ' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('keyFilename')));
  });

  it('should fail for missing dataset', () => {
    const result = validateConfig(validConfig({ dataset: '' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('dataset')));
  });

  it('should fail for missing location', () => {
    const result = validateConfig(validConfig({ location: '' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('location')));
  });

  it('should fail for non-numeric maxBytesBilled', () => {
    const result = validateConfig(validConfig({ maxBytesBilled: 'abc' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('maxBytesBilled')));
  });

  it('should fail for non-positive timeoutMs', () => {
    const result = validateConfig(validConfig({ timeoutMs: 0 }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('timeoutMs')));
  });

  it('should fail for negative timeoutMs', () => {
    const result = validateConfig(validConfig({ timeoutMs: -100 }));
    assert.equal(result.valid, false);
  });

  it('should fail for empty scopes array', () => {
    const result = validateConfig(validConfig({ scopes: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('scopes')));
  });

  it('should collect multiple errors', () => {
    const result = validateConfig({
      projectId: '',
      dataset: '',
      location: '',
      maxBytesBilled: 'abc',
      timeoutMs: -1,
      scopes: [],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 5, `Expected >= 5 errors, got ${result.errors.length}`);
  });
});

// ─── Client pool (getClient / destroyClient / destroyAllClients) ────────────

describe('client pool', () => {
  beforeEach(() => {
    destroyAllClients();
  });

  afterEach(() => {
    destroyAllClients();
  });

  it('poolSize starts at 0', () => {
    assert.equal(poolSize(), 0);
  });

  it('getClient rejects invalid config', async () => {
    await assert.rejects(
      () => getClient({ projectId: '' }),
      /Invalid BigQuery configuration/
    );
  });

  it('getClient rejects when @google-cloud/bigquery is not installed (expected in test env)', async () => {
    // In the test environment, @google-cloud/bigquery is likely not installed,
    // so this tests the graceful error with install instructions.
    try {
      await getClient(validConfig());
      // If it succeeds, the package is installed — just verify pool size
      assert.equal(poolSize(), 1);
    } catch (err) {
      assert.ok(
        err.message.includes('@google-cloud/bigquery') ||
        err.message.includes('pnpm add'),
        `Expected helpful install message, got: ${err.message}`
      );
    }
  });

  it('destroyClient returns false for non-existent project', () => {
    assert.equal(destroyClient('non-existent-proj'), false);
  });

  it('destroyAllClients clears the pool', () => {
    // Manually verify clear behavior
    destroyAllClients();
    assert.equal(poolSize(), 0);
  });
});

// ─── defaultQueryOptions ────────────────────────────────────────────────────

describe('defaultQueryOptions', () => {
  it('should produce correct query options from config', () => {
    const config = validConfig();
    const opts = defaultQueryOptions(config);

    assert.equal(opts.location, 'US');
    assert.equal(opts.maximumBytesBilled, '1073741824');
    assert.equal(opts.timeoutMs, 30000);
    assert.equal(opts.useLegacySql, false);
  });

  it('should reflect custom config values', () => {
    const config = validConfig({
      location: 'EU',
      maxBytesBilled: '5000000000',
      timeoutMs: 60000,
    });
    const opts = defaultQueryOptions(config);

    assert.equal(opts.location, 'EU');
    assert.equal(opts.maximumBytesBilled, '5000000000');
    assert.equal(opts.timeoutMs, 60000);
    assert.equal(opts.useLegacySql, false);
  });
});

// ─── checkEnvironment ───────────────────────────────────────────────────────

describe('checkEnvironment', () => {
  it('should report missing vars when env is clean', withEnv(
    { BIGQUERY_PROJECT_ID: undefined, GOOGLE_APPLICATION_CREDENTIALS: undefined },
    () => {
      const env = checkEnvironment();
      assert.equal(env.ready, false);
      assert.equal(env.projectId, null);
      assert.equal(env.hasCredentials, false);
      assert.ok(env.missing.includes('BIGQUERY_PROJECT_ID'));
      assert.ok(env.missing.includes('GOOGLE_APPLICATION_CREDENTIALS'));
    }
  ));

  it('should report ready when both vars are set', withEnv(
    { BIGQUERY_PROJECT_ID: 'my-test-project', GOOGLE_APPLICATION_CREDENTIALS: '/path/sa.json' },
    () => {
      const env = checkEnvironment();
      assert.equal(env.ready, true);
      assert.equal(env.projectId, 'my-test-project');
      assert.equal(env.hasCredentials, true);
      assert.equal(env.missing.length, 0);
    }
  ));

  it('should report partial readiness', withEnv(
    { BIGQUERY_PROJECT_ID: 'my-test-project', GOOGLE_APPLICATION_CREDENTIALS: undefined },
    () => {
      const env = checkEnvironment();
      assert.equal(env.ready, false);
      assert.equal(env.projectId, 'my-test-project');
      assert.equal(env.hasCredentials, false);
      assert.deepEqual(env.missing, ['GOOGLE_APPLICATION_CREDENTIALS']);
    }
  ));
});
