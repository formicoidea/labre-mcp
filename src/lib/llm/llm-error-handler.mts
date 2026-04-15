// LLM Error Classification and MCP Log Notification Handler
//
// Classifies LLM errors into specific categories (timeout, rate limit, API error,
// empty response, generic) and emits error-level MCP log notifications with
// localized, context-rich messages visible to the user.
//
// Error classification heuristics:
//   - Timeout: AbortError, ETIMEDOUT, ESOCKETTIMEDOUT, "timeout" in message
//   - Rate limit: HTTP 429, "rate limit" / "too many requests" in message
//   - Auth: HTTP 401/403, "unauthorized" / "forbidden" in message
//   - API error: HTTP 4xx/5xx with status code extractable from message
//   - Empty response: "empty response" in message
//   - Generic: anything else
//
// Usage:
//   import { classifyAndLogLLMError } from './llm-error-handler.mjs';
//   try { await llmCall(prompt); }
//   catch (err) { classifyAndLogLLMError(err, { logger, model, msg }); throw err; }

import { logError, logWarning } from '../mcp-notifications.mjs';

// ─── Error Types ──────────────────────────────────────────────────────────

export type LLMErrorType =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'api_error'
  | 'empty_response'
  | 'network'
  | 'generic';

export interface ClassifiedError {
  /** Error category */
  type: LLMErrorType;
  /** HTTP status code if available */
  status: number | null;
  /** Original error message */
  message: string;
  /** Retry-After header value if available */
  retryAfter: string | null;
}

/** Localized message resolver (id + params → string). */
export type MessageResolver = (
  id: string,
  params?: Record<string, unknown>,
) => string;

export interface ErrorLoggingOptions {
  /** Logger name (tool or module name) */
  logger?: string;
  /** LLM model name for context */
  model?: string;
  /** Message resolver from progress-messages.mjs; falls back to English plain messages */
  msg?: MessageResolver | null;
}

/** Narrowed error shape: any thrown value with possible Node.js error codes. */
type ErrorLike = {
  message?: string;
  name?: string;
  code?: string;
} & Record<string, unknown>;

// ─── Error Classification ─────────────────────────────────────────────────

/**
 * Classify an LLM error into a specific category.
 * Uses heuristics on the error object properties and message string.
 */
export function classifyLLMError(error: unknown): ClassifiedError {
  const err = (error ?? {}) as ErrorLike;
  const message = err.message || String(error);
  const lowerMsg = message.toLowerCase();

  // Extract HTTP status code from error message if present
  const statusMatch = message.match(/\b(?:error|status)\s*(\d{3})\b/i);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : null;

  // ── Timeout ─────────────────────────────────────────────────────────
  if (
    err.name === 'AbortError' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'ESOCKETTIMEDOUT' ||
    err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    err.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    err.code === 'UND_ERR_BODY_TIMEOUT' ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('aborted')
  ) {
    return { type: 'timeout', status, message, retryAfter: null };
  }

  // ── Rate limit ──────────────────────────────────────────────────────
  if (
    status === 429 ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('rate_limit') ||
    lowerMsg.includes('too many requests') ||
    lowerMsg.includes('quota exceeded') ||
    lowerMsg.includes('throttl')
  ) {
    const retryMatch = message.match(/retry.?after[:\s]*(\d+)/i);
    const retryAfter = retryMatch ? retryMatch[1] : null;
    return { type: 'rate_limit', status: status || 429, message, retryAfter };
  }

  // ── Auth errors ─────────────────────────────────────────────────────
  if (
    status === 401 || status === 403 ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('forbidden') ||
    lowerMsg.includes('invalid api key') ||
    lowerMsg.includes('api key not configured')
  ) {
    return { type: 'auth', status: status || 401, message, retryAfter: null };
  }

  // ── Network errors ──────────────────────────────────────────────────
  if (
    err.code === 'ECONNREFUSED' ||
    err.code === 'ECONNRESET' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'EAI_AGAIN' ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('dns') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('econnreset')
  ) {
    return { type: 'network', status: null, message, retryAfter: null };
  }

  // ── Empty response ──────────────────────────────────────────────────
  if (
    lowerMsg.includes('empty response') ||
    lowerMsg.includes('returned empty')
  ) {
    return { type: 'empty_response', status, message, retryAfter: null };
  }

  // ── API error with HTTP status ──────────────────────────────────────
  if (status && status >= 400) {
    return { type: 'api_error', status, message, retryAfter: null };
  }

  // ── Generic / unknown ──────────────────────────────────────────────
  return { type: 'generic', status, message, retryAfter: null };
}

// ─── Localized Error Logging ──────────────────────────────────────────────

/**
 * Classify an LLM error and emit an appropriate MCP error-level log notification.
 *
 * Emits localized, context-rich error messages using the progress message catalog.
 * The error is logged but NOT re-thrown — the caller is responsible for propagation.
 */
export function classifyAndLogLLMError(
  error: unknown,
  options: ErrorLoggingOptions = {},
): ClassifiedError {
  const {
    logger = 'llm',
    model = 'unknown',
    msg = null,
  } = options;

  const classified = classifyLLMError(error);

  let logMessage: string;

  switch (classified.type) {
    case 'timeout':
      logMessage = msg
        ? msg('error.llm.timeout', { duration: 'N/A', model })
        : `LLM call timed out (model: ${model}): ${classified.message}`;
      logError(logger, logMessage);
      break;

    case 'rate_limit':
      logMessage = msg
        ? msg('error.llm.ratelimit', { model, retryAfter: classified.retryAfter || '?' })
        : `LLM rate limit exceeded (model: ${model})${classified.retryAfter ? `. Retry after ${classified.retryAfter}s` : ''}: ${classified.message}`;
      logError(logger, logMessage);
      break;

    case 'auth':
      logMessage = msg
        ? msg('error.llm.auth', { status: classified.status || 401 })
        : `LLM authentication error (${classified.status || 401}): ${classified.message}`;
      logError(logger, logMessage);
      break;

    case 'network':
      logMessage = msg
        ? msg('error.llm.network', { message: classified.message })
        : `LLM network error: ${classified.message}`;
      logError(logger, logMessage);
      break;

    case 'empty_response':
      logMessage = msg
        ? msg('error.llm.empty', { model })
        : `LLM returned empty response (model: ${model})`;
      logWarning(logger, logMessage);
      break;

    case 'api_error':
      logMessage = msg
        ? msg('error.llm.api', { status: classified.status, message: classified.message })
        : `LLM API error (${classified.status}): ${classified.message}`;
      logError(logger, logMessage);
      break;

    default: // 'generic'
      logMessage = msg
        ? msg('error.generic', { tool: logger, error: classified.message })
        : `LLM error in ${logger}: ${classified.message}`;
      logError(logger, logMessage);
      break;
  }

  return classified;
}

// ─── Convenience: Wrap an async LLM call with error logging ────────────────

/**
 * Wrap an async function with LLM error classification and logging.
 * Calls the function, and if it throws, classifies the error, emits an MCP
 * error notification, and re-throws the original error.
 */
export async function withLLMErrorLogging<T>(
  fn: () => Promise<T>,
  options: ErrorLoggingOptions = {},
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    classifyAndLogLLMError(error, options);
    throw error;
  }
}
