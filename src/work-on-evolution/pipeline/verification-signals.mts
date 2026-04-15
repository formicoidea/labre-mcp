/**
 * Verification signal builders and timeout racing utility.
 *
 * These functions construct standardised VerificationSignal objects used by the
 * dual-verification orchestrator to represent the outcome of each verification
 * backend (LLM, web-search).
 *
 * @module pipeline/verification-signals
 */

// ─── raceWithTimeout ───────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout.  Resolves (never rejects) with a descriptor
 * indicating whether the promise settled or timed out.
 *
 * @param {Promise} promise    - The promise to race
 * @param {number}  timeoutMs  - Timeout in milliseconds
 * @param {string}  label      - Human-readable label (for debugging)
 * @returns {Promise<{ value: any, timedOut: boolean, error?: Error }>}
 */
export function raceWithTimeout(promise: Promise<any>, timeoutMs: number, label: string): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ value: null, timedOut: true });
      }
    }, timeoutMs);

    promise
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ value, timedOut: false });
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // Re-throw wrapped so Promise.allSettled captures it
          resolve({ value: null, timedOut: false, error: err });
        }
      });
  });
}

// ─── Signal builders ───────────────────────────────────────────────────────────

/**
 * Build a VerificationSignal from a successful verification result.
 *
 * @param {Object} result     - Raw result from the verification backend
 * @param {string} method     - Signal method: 'llm' or 'web-search'
 * @param {number} durationMs - Duration in milliseconds
 * @returns {VerificationSignal}
 */
export function buildSuccessSignal(result: any, method: string, durationMs: number) {
  return {
    classification: result.classification || null,
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    method,
    reasoning: result.reasoning || '',
    status: 'success',
    durationMs,
    raw: result,
  };
}

/**
 * Build a VerificationSignal for a timeout.
 *
 * @param {string} method     - Signal method: 'llm' or 'web-search'
 * @param {number} timeoutMs  - The timeout that was exceeded
 * @param {number} durationMs - Actual elapsed time
 * @returns {VerificationSignal}
 */
export function buildTimeoutSignal(method: string, timeoutMs: number, durationMs: number) {
  return {
    classification: null as string | null,
    confidence: 0,
    method,
    reasoning: `${method} verification timed out after ${timeoutMs}ms`,
    status: 'timeout',
    durationMs,
    error: `Timeout after ${timeoutMs}ms`,
  };
}

/**
 * Build a VerificationSignal for an error.
 *
 * @param {string} method     - Signal method: 'llm' or 'web-search'
 * @param {Error}  err        - The error that occurred
 * @param {number} durationMs - Duration before failure
 * @returns {VerificationSignal}
 */
export function buildErrorSignal(method: string, err: any, durationMs: number) {
  return {
    classification: null as string | null,
    confidence: 0,
    method,
    reasoning: `${method} verification failed: ${err.message}`,
    status: 'error',
    durationMs,
    error: err.message,
  };
}

/**
 * Build a VerificationSignal for a skipped verification.
 *
 * @param {string} method - Signal method: 'llm' or 'web-search'
 * @param {string} reason - Why the signal was skipped
 * @returns {VerificationSignal}
 */
export function buildSkippedSignal(method: string, reason: string) {
  return {
    classification: null as string | null,
    confidence: 0,
    method,
    reasoning: reason,
    status: 'skipped',
    durationMs: 0,
  };
}
