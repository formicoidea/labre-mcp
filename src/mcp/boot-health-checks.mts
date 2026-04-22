// Default health checks registered at MCP server boot.
//
// Each check inspects environment variables or module availability for an
// external dependency the tools rely on. They surface configuration issues
// (missing API keys, missing GCP creds, ...) up-front rather than letting
// the first tool invocation discover them silently.

import { registerHealthCheck } from '../lib/degradation/registry.mjs';
import { checkEnvironment as checkBigQueryEnvironment } from '../lib/patent/bigquery-client.mjs';

/**
 * Register every default health check used by the wardley-assistant MCP
 * server. Idempotent — re-registering the same source overwrites the
 * previous check, which is fine for tests.
 */
export function registerDefaultHealthChecks(): void {
  // ── BigQuery ─────────────────────────────────────────────────────────
  // Wraps the existing checkEnvironment() helper so the CPC strategy and
  // other patent-data consumers can detect a missing project id or creds
  // before issuing any query.
  registerHealthCheck('bigquery', () => {
    const env = checkBigQueryEnvironment();
    if (env.ready) return { ready: true };
    return {
      ready: false,
      reason: `BigQuery not configured (missing: ${env.missing.join(', ')})`,
      detail: { missing: env.missing, projectId: env.projectId, hasCredentials: env.hasCredentials },
    };
  });

  // ── OpenCode LLM ─────────────────────────────────────────────────────
  // The OpenCode provider requires an API key in the environment.
  registerHealthCheck('llm:opencode', () => {
    const hasKey = !!process.env.OPENCODE_API_KEY;
    if (hasKey) return { ready: true };
    return {
      ready: false,
      reason: 'OPENCODE_API_KEY not set',
      detail: { missing: ['OPENCODE_API_KEY'] },
    };
  });

  // ── Claude Agent SDK (also gates web-search) ─────────────────────────
  // The Agent SDK ships with web-search via Claude's `query` tool. There
  // is no env-var prerequisite — presence is signalled by the dependency
  // being installed. Failure to import means web-search and Claude calls
  // are both unavailable.
  registerHealthCheck('llm:claude', async () => {
    try {
      await import('@anthropic-ai/claude-agent-sdk');
      return { ready: true };
    } catch (err) {
      return {
        ready: false,
        reason: '@anthropic-ai/claude-agent-sdk unavailable',
        detail: { error: String(err) },
      };
    }
  });

  registerHealthCheck('web-search', async () => {
    try {
      await import('@anthropic-ai/claude-agent-sdk');
      return { ready: true };
    } catch (err) {
      return {
        ready: false,
        reason: 'web-search unavailable (Claude Agent SDK not loadable)',
        detail: { error: String(err) },
      };
    }
  });
}
