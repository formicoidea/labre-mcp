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

  // ── write-chain LLM resolution ───────────────────────────────────────
  // The generateValueChain tool resolves its LLM via
  // getStrategyLLM('write-chain'). A missing entry in llm.config.json (or
  // a provider that does not support text capability) fails here rather
  // than on the first client call.
  registerHealthCheck('llm:write-chain', async () => {
    try {
      const { getStrategyLLM } = await import('../lib/llm/registry.mjs');
      getStrategyLLM('write-chain');
      return { ready: true };
    } catch (err) {
      return {
        ready: false,
        reason: 'write-chain strategy cannot resolve an LLM',
        detail: { error: String(err) },
      };
    }
  });

  // ── OWM render adapter (vendored cli-owm) ─────────────────────────────
  // verify-layout (write:chain pipeline step 7) renders the in-progress
  // OWM DSL via a render adapter to detect label/component overlaps. A
  // broken vendoring or a renderer crash surfaces here rather than on
  // the first generateValueChain call.
  registerHealthCheck('owm:render', async () => {
    try {
      const { CliOwmAdapter } = await import('../lib/owm/cli-owm-adapter.mjs');
      const svg = new CliOwmAdapter().render(
        'title boot-check\nstyle plain\nanchor A [0.5, 0.5]',
      );
      if (typeof svg !== 'string' || svg.length === 0) {
        throw new Error('cli-owm returned an empty SVG');
      }
      return { ready: true };
    } catch (err) {
      return {
        ready: false,
        reason: 'cli-owm renderer not loadable',
        detail: { error: String(err) },
      };
    }
  });
}
