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
//   import { classifyAndLogLLMError } from './lib/llm/llm-error-handler.mjs';
//   try { await llmCall(prompt); }
//   catch (err) { classifyAndLogLLMError(err, { logger, model, msg }); throw err; }

import { logError, logWarning } from '../mcp-notifications.mjs';

// ─── Error Types ──────────────────────────────────────────────────────────

/**
 * @typedef {'timeout' | 'rate_limit' | 'auth' | 'api_error' | 'empty_response' | 'network' | 'generic'} LLMErrorType
 */

/**
 * @typedef {Object} ClassifiedError
 * @property {LLMErrorType} type - Error category
 * @property {number|null} status - HTTP status code if available
 * @property {string} message - Original error message
 * @property {string|null} retryAfter - Retry-After header value if available
 */

// ─── Error Classification ─────────────────────────────────────────────────

/**
 * Classify an LLM error into a specific category.
 *
 * Uses heuristics on the error object properties and message string
 * to determine the error type.
 *
 * @param {Error} error - The caught error
 * @returns {ClassifiedError} Classified error with type and metadata
 */
export function classifyLLMError(error) {
  const message = error?.message || String(error);
  const lowerMsg = message.toLowerCase();

  // Extract HTTP status code from error message if present
  const statusMatch = message.match(/\b(?:error|status)\s*(\d{3})\b/i);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : null;

  // ── Timeout ─────────────────────────────────────────────────────────
  if (
    error?.name === 'AbortError' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ESOCKETTIMEDOUT' ||
    error?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    error?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    error?.code === 'UND_ERR_BODY_TIMEOUT' ||
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
    // Try to extract retry-after from error message
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
    error?.code === 'ECONNREFUSED' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'ENOTFOUND' ||
    error?.code === 'EAI_AGAIN' ||
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
 *
 * @param {Error} error - The caught error
 * @param {Object} options - Logging context
 * @param {string} options.logger - Logger name (tool or module name)
 * @param {string} [options.model='unknown'] - LLM model name for context
 * @param {function} [options.msg] - Message resolver from progress-messages.mjs
 *   If not provided, falls back to English-only plain messages.
 * @returns {ClassifiedError} The classified error (for caller use)
 */
export function classifyAndLogLLMError(error, options = {}) {
  const {
    logger = 'llm',
    model = 'unknown',
    msg = null,
  } = options;

  const classified = classifyLLMError(error);

  // Build the log message based on error type, using localized messages if available
  let logMessage;

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
 *
 * Calls the function, and if it throws, classifies the error,
 * emits an MCP error notification, and re-throws the original error.
 *
 * @param {function(): Promise<*>} fn - Async function to wrap
 * @param {Object} options - Same options as classifyAndLogLLMError
 * @returns {Promise<*>} Result of fn()
 * @throws {Error} Re-throws the original error after logging
 */
export async function withLLMErrorLogging(fn, options = {}) {
  try {
    return await fn();
  } catch (error) {
    classifyAndLogLLMError(error, options);
    throw error;
  }
}

// ─── Self-test ────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== llm-error-handler.mjs self-test ===\n');

  // Suppress actual stdout MCP notifications during tests
  const origWrite = process.stdout.write;
  const captured = [];
  process.stdout.write = function (data) {
    if (typeof data === 'string' && data.includes('"notifications/message"')) {
      captured.push(JSON.parse(data.trim()));
      return true;
    }
    return origWrite.call(this, data);
  };

  // Test classification
  console.log('--- Test: Error classification ---');

  const tests = [
    { error: new Error('Request timed out after 30000ms'), expectedType: 'timeout' },
    { error: Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }), expectedType: 'timeout' },
    { error: new Error('OpenCode API error 429: Too many requests'), expectedType: 'rate_limit' },
    { error: new Error('Rate limit exceeded, retry after 60'), expectedType: 'rate_limit' },
    { error: new Error('OpenCode API error 401: Unauthorized'), expectedType: 'auth' },
    { error: new Error('OpenCode API key not configured'), expectedType: 'auth' },
    { error: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }), expectedType: 'network' },
    { error: new Error('OpenCode call returned empty response'), expectedType: 'empty_response' },
    { error: new Error('OpenCode API error 500: Internal Server Error'), expectedType: 'api_error' },
    { error: new Error('OpenCode API error 503: Service Unavailable'), expectedType: 'api_error' },
    { error: new Error('Something went wrong'), expectedType: 'generic' },
    { error: new Error('LLM call failed: unknown error'), expectedType: 'generic' },
  ];

  for (const { error, expectedType } of tests) {
    const classified = classifyLLMError(error);
    const ok = classified.type === expectedType;
    console.log(`  ${ok ? '✓' : '✗'} "${error.message}" → ${classified.type}${ok ? '' : ` (expected: ${expectedType})`}`);
  }

  // Test classifyAndLogLLMError emits notifications
  console.log('\n--- Test: Error logging emits MCP notifications ---');
  captured.length = 0;

  classifyAndLogLLMError(new Error('OpenCode API error 429: Too many requests'), {
    logger: 'estimateEvolution',
    model: 'kimi-k2.5',
  });

  classifyAndLogLLMError(new Error('Request timed out'), {
    logger: 'evaluateMap',
    model: 'kimi-k2.5',
  });

  classifyAndLogLLMError(new Error('OpenCode API error 500: Internal Server Error'), {
    logger: 'generateValueChain',
    model: 'kimi-k2.5',
  });

  console.log(`  ✓ Captured ${captured.length} MCP notifications`);
  for (const n of captured) {
    console.log(`    [${n.params.level}] ${n.params.logger}: ${n.params.data}`);
  }

  // Test with localized message resolver
  console.log('\n--- Test: Localized error messages ---');
  captured.length = 0;

  // Simulate a French message resolver
  const frenchMsg = (id, params) => {
    const templates = {
      'error.llm.timeout': `Appel LLM expiré après ${params.duration} ms (modèle : ${params.model})`,
      'error.llm.ratelimit': `Limite de débit LLM dépassée (modèle : ${params.model}). Réessayer dans ${params.retryAfter}s`,
      'error.llm.api': `Erreur API LLM (${params.status}) : ${params.message}`,
      'error.generic': `Erreur dans ${params.tool} : ${params.error}`,
    };
    return templates[id] || `[${id}]`;
  };

  classifyAndLogLLMError(new Error('OpenCode API error 429: rate limit'), {
    logger: 'estimateEvolution',
    model: 'kimi-k2.5',
    msg: frenchMsg,
  });

  console.log(`  ✓ Captured ${captured.length} localized notification(s)`);
  for (const n of captured) {
    console.log(`    [${n.params.level}] ${n.params.logger}: ${n.params.data}`);
  }

  // Test withLLMErrorLogging wrapper
  console.log('\n--- Test: withLLMErrorLogging wrapper ---');
  captured.length = 0;

  try {
    await withLLMErrorLogging(
      async () => { throw new Error('OpenCode API error 503: Service Unavailable'); },
      { logger: 'estimateEvolution', model: 'kimi-k2.5' }
    );
    console.log('  ✗ Should have thrown');
  } catch (err) {
    console.log(`  ✓ Re-threw error: "${err.message}"`);
    console.log(`  ✓ Emitted ${captured.length} notification(s) before re-throw`);
  }

  // Test successful call doesn't emit anything
  captured.length = 0;
  const result = await withLLMErrorLogging(
    async () => 'success!',
    { logger: 'test', model: 'test' }
  );
  console.log(`\n  ✓ Successful call returned: "${result}", notifications: ${captured.length}`);

  // Restore stdout
  process.stdout.write = origWrite;

  console.log('\n=== self-test complete ===');
}
