// MCP Log Notification utility
//
// Sends JSON-RPC 2.0 notifications (method: "notifications/message") to stdout,
// following the MCP specification for server-initiated log messages.
//
// These notifications are fire-and-forget (no id, no response expected).
// They allow MCP clients (e.g., Claude Code) to display real-time progress
// during tool execution.
//
// Verbose mode:
//   Debug-level messages are only emitted when verbose mode is enabled.
//   Toggle via environment variable WARDLEY_VERBOSE=1 (or "true"/"yes")
//   or programmatically with setVerbose(true/false).
//   Info, warning, and error levels are always emitted regardless of this flag.
//
// Spec: https://modelcontextprotocol.io/specification — Logging
//
// Usage:
//   import { sendLog, logInfo, logDebug, logError, setVerbose, isVerbose } from './mcp-notifications.mjs';
//   logInfo('estimateEvolution', 'Starting evaluation for "ERP"');
//   logDebug('estimateEvolution', 'Parsing input...'); // only if verbose

// ─── Log Levels ─────────────────────────────────────────────────────────────

/** Valid MCP log levels (subset used by this project). */
export const LOG_LEVELS = ['debug', 'info', 'warning', 'error'];

// ─── Verbose Mode ───────────────────────────────────────────────────────────

/**
 * Resolve the initial verbose state from environment variable WARDLEY_VERBOSE.
 * Accepts "1", "true", or "yes" (case-insensitive) as truthy values.
 */
function resolveVerboseFromEnv() {
  const raw = (process.env.WARDLEY_VERBOSE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Internal verbose flag — mutable via setVerbose(). */
let _verbose = resolveVerboseFromEnv();

/**
 * Enable or disable verbose mode programmatically.
 * When disabled, debug-level messages are silently dropped.
 *
 * @param {boolean} enabled - true to enable debug messages, false to suppress
 */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export function setVerbose(enabled: boolean): void {
  _verbose = Boolean(enabled);
}

/**
 * Returns the current verbose mode state.
 *
 * @returns {boolean} true if debug-level messages will be emitted
 */
export function isVerbose() {
  return _verbose;
}

// ─── Core Send Function ─────────────────────────────────────────────────────

/**
 * Send an MCP log notification to stdout.
 *
 * Emits both:
 *   - notifications/claude/channel (for Claude Code chat visibility)
 *   - notifications/message (standard MCP logging, for other clients)
 *
 * @param {string} level - Log level: 'debug' | 'info' | 'warning' | 'error'
 * @param {string} logger - Logger name (typically the tool name)
 * @param {string} data - Human-readable log message
 */
export function sendLog(level: LogLevel, logger: string, data: string): void {
  // Channel notification — visible in Claude Code chat
  const channel = {
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: {
      content: data,
      meta: {
        level,
        tool: logger,
      },
    },
  };
  process.stdout.write(JSON.stringify(channel) + '\n');

  // Standard MCP log — for non-Claude clients
  const standard = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level,
      logger,
      data,
    },
  };
  process.stdout.write(JSON.stringify(standard) + '\n');
}

// ─── Convenience Helpers ────────────────────────────────────────────────────

/**
 * Send an info-level log notification.
 * Use for start/end of tool invocations.
 *
 * @param {string} logger - Logger name (tool name)
 * @param {string} message - Human-readable message
 */
export function logInfo(logger: string, message: string): void {
  sendLog('info', logger, message);
}

/**
 * Send a debug-level log notification.
 * Use for intermediate steps (parsing, LLM calls, strategy evaluation).
 *
 * **Only emitted when verbose mode is enabled** (WARDLEY_VERBOSE=1 or setVerbose(true)).
 * When verbose mode is off, this function is a no-op.
 *
 * @param {string} logger - Logger name (tool name)
 * @param {string} message - Human-readable message
 */
export function logDebug(logger: string, message: string): void {
  if (!_verbose) return;
  sendLog('debug', logger, message);
}

/**
 * Send an error-level log notification.
 * Use for LLM errors, timeouts, rate limits, API failures.
 *
 * @param {string} logger - Logger name (tool name)
 * @param {string} message - Human-readable error description
 */
export function logError(logger: string, message: string): void {
  sendLog('error', logger, message);
}

/**
 * Send a warning-level log notification.
 *
 * @param {string} logger - Logger name (tool name)
 * @param {string} message - Human-readable warning
 */
export function logWarning(logger: string, message: string): void {
  sendLog('warning', logger, message);
}
