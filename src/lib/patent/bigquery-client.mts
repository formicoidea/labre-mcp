import { toErrorMessage, errorCode } from '../errors.mjs';

// BigQuery client configuration and authentication helper.
//
// Isolated module responsible for:
//   1. Service account authentication (GOOGLE_APPLICATION_CREDENTIALS or ADC)
//   2. Project/dataset configuration (BIGQUERY_PROJECT_ID env var)
//   3. Connection pooling via singleton BigQuery client instance
//   4. Configuration validation with clear error messages
//
// This module is consumed by BigQueryPatentSource (bigquery-patent-source.mjs)
// and should NOT be imported directly by strategy code.
//
// Required environment variables:
//   BIGQUERY_PROJECT_ID            - GCP project ID hosting BigQuery access
//   GOOGLE_APPLICATION_CREDENTIALS - Path to service account JSON key file (standard GCP)
//
// Optional environment variables:
//   BIGQUERY_DATASET       - Dataset override (default: 'patents-public-data')
//   BIGQUERY_LOCATION      - BigQuery job location (default: 'US')
//   BIGQUERY_MAX_BYTES     - Maximum bytes billed per query (default: 1GB)
//   BIGQUERY_TIMEOUT_MS    - Query timeout in ms (default: 30000)
//   BIGQUERY_SCOPES        - Comma-separated OAuth scopes (default: bigquery.readonly)

// ─── Default configuration ──────────────────────────────────────────────────

/**
 * Default BigQuery configuration values.
 * Tuned for the Google Patents Public Dataset with conservative billing limits.
 *
 * @type {Readonly<BigQueryConfig>}
 */
export const DEFAULTS = Object.freeze({
  /** Google Patents Public Dataset — the primary data source for patent CPC data. */
  dataset: 'patents-public-data',

  /** BigQuery job location — US for the public patents dataset. */
  location: 'US',

  /** Maximum bytes billed per query (200 GB). Public dataset free tier is 1 TB/month. */
  maxBytesBilled: String(200 * 1024 * 1024 * 1024), // '214748364800'

  /** Query timeout in milliseconds (30 seconds). */
  timeoutMs: 30_000,

  /** OAuth scopes — read-only access is sufficient for patent queries. */
  scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
});

// ─── Configuration typedefs ─────────────────────────────────────────────────

/**
 * BigQuery client configuration.
 *
 * @typedef {Object} BigQueryConfig
 * @property {string}   projectId     - GCP project ID
 * @property {string}   [keyFilename] - Path to service account JSON key file
 * @property {string}   dataset       - BigQuery dataset name
 * @property {string}   location      - BigQuery job location
 * @property {string}   maxBytesBilled - Maximum bytes billed per query (string for BQ API)
 * @property {number}   timeoutMs     - Query timeout in milliseconds
 * @property {string[]} scopes        - OAuth scopes for authentication
 */

/**
 * Validated and resolved configuration ready for BigQuery client instantiation.
 *
 * @typedef {Object} ResolvedConfig
 * @property {string}   projectId      - Validated GCP project ID
 * @property {string}   [keyFilename]  - Resolved path to credentials file (if set)
 * @property {string}   dataset        - Dataset name
 * @property {string}   location       - Job location
 * @property {string}   maxBytesBilled - Max bytes as string
 * @property {number}   timeoutMs      - Query timeout in ms
 * @property {string[]} scopes         - OAuth scopes
 */

// ─── Configuration resolution ───────────────────────────────────────────────

/**
 * Resolve BigQuery configuration from explicit options + environment variables + defaults.
 *
 * Resolution priority (highest to lowest):
 *   1. Explicit options passed to the function
 *   2. Environment variables (BIGQUERY_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS, etc.)
 *   3. Built-in defaults from DEFAULTS
 *
 * @param {Partial<BigQueryConfig>} [options={}] - Explicit config overrides
 * @returns {ResolvedConfig} Fully resolved configuration
 * @throws {Error} If BIGQUERY_PROJECT_ID is missing from both options and env
 */
export function resolveConfig(options: any = {}): any {
  const env = typeof process !== 'undefined' ? process.env : {};

  // ── Project ID (required) ────────────────────────────────────────────────
  const projectId = options.projectId
    || env.BIGQUERY_PROJECT_ID
    || null;

  if (!projectId) {
    throw new Error(
      'BigQuery project ID is required. Set BIGQUERY_PROJECT_ID environment variable ' +
      'or pass { projectId } in options.'
    );
  }

  // ── Service account credentials (optional — falls back to ADC) ───────────
  const keyFilename = options.keyFilename
    || env.GOOGLE_APPLICATION_CREDENTIALS
    || undefined;

  // ── Dataset ──────────────────────────────────────────────────────────────
  const dataset = options.dataset
    || env.BIGQUERY_DATASET
    || DEFAULTS.dataset;

  // ── Location ─────────────────────────────────────────────────────────────
  const location = options.location
    || env.BIGQUERY_LOCATION
    || DEFAULTS.location;

  // ── Max bytes billed ─────────────────────────────────────────────────────
  const maxBytesBilled = options.maxBytesBilled
    || env.BIGQUERY_MAX_BYTES
    || DEFAULTS.maxBytesBilled;

  // ── Query timeout ────────────────────────────────────────────────────────
  const timeoutMs = options.timeoutMs
    || (env.BIGQUERY_TIMEOUT_MS ? Number(env.BIGQUERY_TIMEOUT_MS) : null)
    || DEFAULTS.timeoutMs;

  // ── OAuth scopes ─────────────────────────────────────────────────────────
  const scopes = options.scopes
    || (env.BIGQUERY_SCOPES ? env.BIGQUERY_SCOPES.split(',').map(s => s.trim()) : null)
    || DEFAULTS.scopes;

  return {
    projectId,
    keyFilename,
    dataset,
    location,
    maxBytesBilled: String(maxBytesBilled),
    timeoutMs: Number(timeoutMs),
    scopes,
  };
}

// ─── Configuration validation ───────────────────────────────────────────────

/**
 * Validate a resolved BigQuery configuration.
 * Returns a list of issues (empty if config is valid).
 *
 * @param {ResolvedConfig} config - Configuration to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfig(config: any) {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be a non-null object'] };
  }

  // projectId: required, must be a non-empty string matching GCP project naming
  if (!config.projectId || typeof config.projectId !== 'string') {
    errors.push('projectId is required and must be a non-empty string');
  } else if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId)) {
    // GCP project IDs: 6–30 chars, lowercase letters/digits/hyphens, starts with letter, ends with letter/digit
    errors.push(
      `projectId "${config.projectId}" does not match GCP project ID format ` +
      '(6-30 chars, lowercase, starts with letter)'
    );
  }

  // keyFilename: if provided, must be a non-empty string
  if (config.keyFilename != null && (typeof config.keyFilename !== 'string' || !config.keyFilename.trim())) {
    errors.push('keyFilename, if provided, must be a non-empty string path');
  }

  // dataset: required non-empty string
  if (!config.dataset || typeof config.dataset !== 'string') {
    errors.push('dataset is required and must be a non-empty string');
  }

  // location: required non-empty string
  if (!config.location || typeof config.location !== 'string') {
    errors.push('location is required and must be a non-empty string');
  }

  // maxBytesBilled: must be a numeric string
  if (!config.maxBytesBilled || isNaN(Number(config.maxBytesBilled))) {
    errors.push('maxBytesBilled must be a numeric string');
  }

  // timeoutMs: positive number
  if (typeof config.timeoutMs !== 'number' || config.timeoutMs <= 0) {
    errors.push('timeoutMs must be a positive number');
  }

  // scopes: non-empty array of strings
  if (!Array.isArray(config.scopes) || config.scopes.length === 0) {
    errors.push('scopes must be a non-empty array of OAuth scope strings');
  }

  return { valid: errors.length === 0, errors };
}

// ─── Client singleton pool ──────────────────────────────────────────────────

/**
 * Pool of BigQuery client instances keyed by projectId.
 * Reuses existing clients to avoid redundant connection setup and
 * authentication overhead across multiple queries.
 *
 * @type {Map<string, Object>}
 */
const clientPool = new Map();

/**
 * Create or retrieve a BigQuery client instance for the given configuration.
 *
 * Uses a singleton pool keyed by projectId: if a client already exists for
 * the project, it is reused. This avoids redundant authentication handshakes
 * and connection setup when multiple queries target the same project.
 *
 * The client is lazily created on first call and cached for the process lifetime
 * (or until destroyClient() is called).
 *
 * @param {ResolvedConfig} config - Resolved BigQuery configuration
 * @returns {Promise<Object>} BigQuery client instance (from @google-cloud/bigquery)
 * @throws {Error} If @google-cloud/bigquery is not installed
 * @throws {Error} If configuration is invalid
 */
export async function getClient(config: Record<string, unknown> = {}) {
  // Validate config before attempting client creation
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(
      `Invalid BigQuery configuration: ${validation.errors.join('; ')}`
    );
  }

  const poolKey = config.projectId;

  // Return cached client if available
  if (clientPool.has(poolKey)) {
    return clientPool.get(poolKey);
  }

  // Lazy-load @google-cloud/bigquery to fail gracefully if not installed
  let BigQuery;
  try {
    const module = await import('@google-cloud/bigquery');
    BigQuery = module.BigQuery;
  } catch (err) {
    throw new Error(
      'The @google-cloud/bigquery package is required for patent data access. ' +
      'Install it with: pnpm add @google-cloud/bigquery\n' +
      `Original error: ${toErrorMessage(err)}`
    );
  }

  // Build client options
  const clientOptions = {
    projectId: config.projectId,
    location: config.location,
    scopes: config.scopes,
  } as any;  // any: BigQuery query options shape varies by SDK version

  // Add service account key file if provided (otherwise relies on ADC)
  if (config.keyFilename) {
    clientOptions.keyFilename = config.keyFilename;
  }

  const client = new BigQuery(clientOptions);

  // Cache the client for reuse
  clientPool.set(poolKey, client);

  return client;
}

/**
 * Destroy (remove from pool) the BigQuery client for a given project.
 * Use this for graceful shutdown or to force re-authentication.
 *
 * @param {string} projectId - GCP project ID whose client to destroy
 * @returns {boolean} true if a client was removed, false if none existed
 */
export function destroyClient(projectId: string) {
  return clientPool.delete(projectId);
}

/**
 * Destroy all pooled BigQuery clients.
 * Call this during process shutdown to release all resources.
 */
export function destroyAllClients() {
  clientPool.clear();
}

/**
 * Get the current number of pooled clients (for monitoring/testing).
 * @returns {number}
 */
export function poolSize() {
  return clientPool.size;
}

// ─── Query helper ───────────────────────────────────────────────────────────

/**
 * Default query options derived from configuration.
 * Used by BigQueryPatentSource to run parameterized queries with consistent
 * billing and timeout controls.
 *
 * @param {ResolvedConfig} config - Resolved BigQuery configuration
 * @returns {Object} Base query options for BigQuery .query() calls
 */
export function defaultQueryOptions(config: any) {
  return {
    location: config.location,
    maximumBytesBilled: config.maxBytesBilled,
    timeoutMs: config.timeoutMs,
    useLegacySql: false,
  };
}

// ─── Environment check helper ───────────────────────────────────────────────

/**
 * Check whether the required environment variables are set for BigQuery access.
 * Returns a diagnostic object (does not throw) — useful for health checks and
 * graceful degradation in the strategy pipeline.
 *
 * @returns {{ ready: boolean, projectId: string|null, hasCredentials: boolean, missing: string[] }}
 */
export function checkEnvironment() {
  const env = typeof process !== 'undefined' ? process.env : {};

  const missing = [];
  const projectId = env.BIGQUERY_PROJECT_ID || null;
  const hasCredentials = !!env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!projectId) missing.push('BIGQUERY_PROJECT_ID');
  if (!hasCredentials) missing.push('GOOGLE_APPLICATION_CREDENTIALS');

  return {
    ready: missing.length === 0,
    projectId,
    hasCredentials,
    missing,
  };
}
