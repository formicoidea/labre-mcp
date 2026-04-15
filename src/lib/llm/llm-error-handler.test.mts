// Tests for llm-error-handler.mjs — LLM error classification and MCP notification
//
// Validates:
//   1. Error classification accuracy for all error types
//   2. MCP error-level notifications are emitted with correct level/logger
//   3. Localized message integration works
//   4. withLLMErrorLogging wrapper re-throws after logging
//   5. Rate limit retry-after extraction
//   6. HTTP status code extraction from error messages

import { classifyLLMError, classifyAndLogLLMError, withLLMErrorLogging } from './llm-error-handler.mjs';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

// Capture MCP notifications written to stdout
const origWrite = process.stdout.write;
let captured = [];
process.stdout.write = function (data) {
  if (typeof data === 'string' && data.includes('"notifications/message"')) {
    captured.push(JSON.parse(data.trim()));
    return true;
  }
  return origWrite.call(this, data);
};

console.log('=== llm-error-handler.test.mjs ===\n');

// ── 1. Error Classification ────────────────────────────────────────────────

console.log('--- 1. Timeout detection ---');
assert(classifyLLMError(new Error('Request timed out')).type === 'timeout', 'timeout keyword');
assert(classifyLLMError(new Error('Operation aborted')).type === 'timeout', 'aborted keyword');
assert(classifyLLMError(Object.assign(new Error(''), { code: 'ETIMEDOUT' })).type === 'timeout', 'ETIMEDOUT code');
assert(classifyLLMError(Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT' })).type === 'timeout', 'UND_ERR_CONNECT_TIMEOUT');
assert(classifyLLMError(Object.assign(new Error('x'), { name: 'AbortError' })).type === 'timeout', 'AbortError name');

console.log('\n--- 2. Rate limit detection ---');
assert(classifyLLMError(new Error('OpenCode API error 429: Too Many Requests')).type === 'rate_limit', '429 status');
assert(classifyLLMError(new Error('rate limit exceeded')).type === 'rate_limit', 'rate limit text');
assert(classifyLLMError(new Error('Too many requests')).type === 'rate_limit', 'too many requests');
assert(classifyLLMError(new Error('Quota exceeded for model')).type === 'rate_limit', 'quota exceeded');
assert(classifyLLMError(new Error('Request throttled')).type === 'rate_limit', 'throttled');

console.log('\n--- 3. Rate limit retry-after extraction ---');
const rl1 = classifyLLMError(new Error('Rate limit exceeded. Retry-After: 60'));
assert(rl1.retryAfter === '60', 'extracts retry-after 60');
const rl2 = classifyLLMError(new Error('Rate limit. retry after 30 seconds'));
assert(rl2.retryAfter === '30', 'extracts retry after 30');
const rl3 = classifyLLMError(new Error('Rate limit exceeded'));
assert(rl3.retryAfter === null, 'null when no retry-after');

console.log('\n--- 4. Auth detection ---');
assert(classifyLLMError(new Error('OpenCode API error 401: Unauthorized')).type === 'auth', '401 status');
assert(classifyLLMError(new Error('OpenCode API error 403: Forbidden')).type === 'auth', '403 status');
assert(classifyLLMError(new Error('Invalid API key')).type === 'auth', 'invalid api key');
assert(classifyLLMError(new Error('API key not configured')).type === 'auth', 'key not configured');

console.log('\n--- 5. Network detection ---');
assert(classifyLLMError(Object.assign(new Error(''), { code: 'ECONNREFUSED' })).type === 'network', 'ECONNREFUSED');
assert(classifyLLMError(Object.assign(new Error(''), { code: 'ENOTFOUND' })).type === 'network', 'ENOTFOUND');
assert(classifyLLMError(new Error('fetch failed')).type === 'network', 'fetch failed');
assert(classifyLLMError(Object.assign(new Error(''), { code: 'ECONNRESET' })).type === 'network', 'ECONNRESET');

console.log('\n--- 6. Empty response detection ---');
assert(classifyLLMError(new Error('OpenCode call returned empty response')).type === 'empty_response', 'empty response');
assert(classifyLLMError(new Error('LLM returned empty response')).type === 'empty_response', 'returned empty');

console.log('\n--- 7. API error detection ---');
assert(classifyLLMError(new Error('OpenCode API error 500: Internal Server Error')).type === 'api_error', '500 error');
assert(classifyLLMError(new Error('OpenCode API error 503: Service Unavailable')).type === 'api_error', '503 error');
assert(classifyLLMError(new Error('OpenCode API error 502: Bad Gateway')).type === 'api_error', '502 error');

console.log('\n--- 8. HTTP status extraction ---');
assert(classifyLLMError(new Error('API error 503: oops')).status === 503, 'extracts 503');
assert(classifyLLMError(new Error('status 429')).status === 429, 'extracts 429');
assert(classifyLLMError(new Error('just a message')).status === null, 'null when no status');

console.log('\n--- 9. Generic fallback ---');
assert(classifyLLMError(new Error('Something went wrong')).type === 'generic', 'unknown error → generic');
assert(classifyLLMError(new Error('LLM call failed: unknown')).type === 'generic', 'failed unknown → generic');

// ── 2. MCP Notification Emission ───────────────────────────────────────────

console.log('\n--- 10. MCP error notifications ---');
captured = [];

classifyAndLogLLMError(new Error('OpenCode API error 429: rate limited'), {
  logger: 'estimateEvolution', model: 'kimi-k2.5',
});
assert(captured.length === 1, 'emits 1 notification for rate limit');
assert(captured[0].params.level === 'error', 'level is error');
assert(captured[0].params.logger === 'estimateEvolution', 'logger is estimateEvolution');
assert(captured[0].params.data.includes('rate limit'), 'message mentions rate limit');

captured = [];
classifyAndLogLLMError(new Error('Request timed out'), {
  logger: 'evaluateMap', model: 'kimi-k2.5',
});
assert(captured.length === 1, 'emits 1 notification for timeout');
assert(captured[0].params.level === 'error', 'timeout level is error');
assert(captured[0].params.data.includes('timed out'), 'timeout message content');

captured = [];
classifyAndLogLLMError(new Error('OpenCode call returned empty response'), {
  logger: 'test', model: 'kimi-k2.5',
});
assert(captured.length === 1, 'emits 1 notification for empty');
assert(captured[0].params.level === 'warning', 'empty response level is warning');

// ── 3. Localized Messages ─────────────────────────────────────────────────

console.log('\n--- 11. Localized error messages via msg resolver ---');
captured = [];

const frMsg = (id, params) => {
  if (id === 'error.llm.timeout') return `Appel LLM expiré (modèle: ${params.model})`;
  if (id === 'error.llm.ratelimit') return `Limite débit (${params.model}), retry: ${params.retryAfter}s`;
  if (id === 'error.llm.auth') return `Auth échouée (${params.status})`;
  if (id === 'error.llm.network') return `Erreur réseau: ${params.message}`;
  if (id === 'error.llm.empty') return `Réponse vide (${params.model})`;
  if (id === 'error.llm.api') return `Erreur API (${params.status}): ${params.message}`;
  if (id === 'error.generic') return `Erreur ${params.tool}: ${params.error}`;
  return id;
};

classifyAndLogLLMError(new Error('Request timed out'), { logger: 't', model: 'kimi', msg: frMsg });
assert(captured[0].params.data.includes('Appel LLM expiré'), 'French timeout message');

captured = [];
classifyAndLogLLMError(new Error('API error 429: rate'), { logger: 't', model: 'kimi', msg: frMsg });
assert(captured[0].params.data.includes('Limite débit'), 'French rate limit message');

captured = [];
classifyAndLogLLMError(new Error('API key not configured'), { logger: 't', model: 'kimi', msg: frMsg });
assert(captured[0].params.data.includes('Auth échouée'), 'French auth message');

captured = [];
classifyAndLogLLMError(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }), { logger: 't', model: 'kimi', msg: frMsg });
assert(captured[0].params.data.includes('Erreur réseau'), 'French network message');

captured = [];
classifyAndLogLLMError(new Error('returned empty response'), { logger: 't', model: 'kimi', msg: frMsg });
assert(captured[0].params.data.includes('Réponse vide'), 'French empty response message');

// ── 4. withLLMErrorLogging Wrapper ─────────────────────────────────────────

console.log('\n--- 12. withLLMErrorLogging wrapper ---');
captured = [];

let caughtError = null;
try {
  await withLLMErrorLogging(
    async () => { throw new Error('OpenCode API error 500: oops'); },
    { logger: 'test', model: 'kimi-k2.5' }
  );
} catch (err) {
  caughtError = err;
}
assert(caughtError !== null, 'error is re-thrown');
assert(caughtError.message.includes('500'), 'original error preserved');
assert(captured.length === 1, 'notification emitted before re-throw');
assert(captured[0].params.level === 'error', 'wrapper emits error level');

captured = [];
const successResult = await withLLMErrorLogging(
  async () => 42,
  { logger: 'test', model: 'test' }
);
assert(successResult === 42, 'successful call returns value');
assert(captured.length === 0, 'no notifications on success');

// ── 5. Return Value ────────────────────────────────────────────────────────

console.log('\n--- 13. classifyAndLogLLMError returns classified error ---');
captured = [];
const returned = classifyAndLogLLMError(new Error('API error 503: down'), { logger: 'x', model: 'y' });
assert(returned.type === 'api_error', 'returns classified type');
assert(returned.status === 503, 'returns classified status');

// ── Summary ─────────────────────────────────────────────────────────────────

// Restore stdout
process.stdout.write = origWrite;

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
