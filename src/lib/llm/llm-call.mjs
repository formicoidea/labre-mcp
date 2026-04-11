// Generic LLM call module — multi-backend support.
//
// Two backends:
//   1. Claude Agent SDK (default) — for text completion, no logprobs
//   2. OpenCode API gateway — for kimi-k2.5 with real logprobs
//
// Usage:
//   import { createLLMCall, createOpenCodeLogprobCall } from './lib/llm/llm-call.mjs';
//   const llmCall = createLLMCall();
//   const text = await llmCall('Analyze {{component}}', { component: 'ERP' });
//
//   const logprobCall = createOpenCodeLogprobCall();
//   const { text, logprobs } = await logprobCall('Classify {{component}}', { component: 'ERP' });

import { query } from '@anthropic-ai/claude-agent-sdk';
import { classifyAndLogLLMError } from './llm-error-handler.mjs';

// ─── Retry Configuration (aligned with Ouroboros claude_code_adapter) ───────

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;
const RETRYABLE_PATTERNS = [
  'concurrency', 'rate', 'timeout', 'overloaded',
  'temporarily', 'empty response', 'need retry', 'startup',
  'unknown error',
];

function isRetryableError(err) {
  const msg = String(err.message || err).toLowerCase();
  return RETRYABLE_PATTERNS.some(p => msg.includes(p));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Template Interpolation ─────────────────────────────────────────────────

/**
 * Replace {{variable}} placeholders in a template string.
 *
 * @param {string} template - Prompt with {{variable}} placeholders
 * @param {Object<string, string>} [variables] - Key-value map
 * @returns {string} Interpolated string
 */
export function interpolate(template, variables) {
  if (!variables || Object.keys(variables).length === 0) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? String(variables[key]) : match;
  });
}

// ─── Backend 1: Claude Agent SDK ────────────────────────────────────────────

/**
 * Create a reusable LLM call function backed by the Claude Agent SDK.
 * Uses query() with tools disabled for pure text completion.
 *
 * @param {Object} [config={}]
 * @param {string} [config.model='claude-sonnet-4-6']
 * @param {string} [config.effort='high'] - 'low' | 'medium' | 'high'
 * @param {number} [config.maxBudgetUsd=0.10]
 * @param {string} [config.systemPrompt] - Optional system prompt
 * @returns {function(string, Object?): Promise<string>}
 */
export function createLLMCall(config = {}) {
  const {
    model = 'claude-sonnet-4-6',
    effort = 'high',
    maxBudgetUsd = 0.10,
    systemPrompt,
  } = config;

  return async function llmCall(prompt, variables) {
    const interpolatedPrompt = interpolate(prompt, variables);

    // Prevent nested session detection that causes silent empty responses
    if (process.env.CLAUDECODE) {
      delete process.env.CLAUDECODE;
    }

    const options = {
      model,
      maxTurns: 1,
      effort,
      maxBudgetUsd,
      persistSession: false,
      disallowedTools: ['Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Read'],
    };

    if (systemPrompt) {
      options.systemPrompt = systemPrompt;
    }

    const errorContext = { logger: 'llm-call', model };

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let resultText = '';
        for await (const message of query({ prompt: interpolatedPrompt, options })) {
          if (message.type === 'result') {
            if (message.subtype === 'success') {
              resultText = message.result || '';
            } else {
              const errors = message.errors || [];
              throw new Error(`LLM call failed: ${errors.join(', ') || 'unknown error'}`);
            }
          }
        }
        if (!resultText) {
          throw new Error('LLM call returned empty response');
        }
        return resultText;
      } catch (err) {
        lastError = err;
        if (isRetryableError(err) && attempt < MAX_RETRIES - 1) {
          const backoff = INITIAL_BACKOFF_MS * (2 ** attempt);
          await sleep(backoff);
          continue;
        }
        classifyAndLogLLMError(err, errorContext);
        throw err;
      }
    }
    classifyAndLogLLMError(lastError, errorContext);
    throw lastError;
  };
}

/**
 * Create an LLM call that returns structured JSON via the Agent SDK.
 *
 * @param {Object} [config={}]
 * @param {Object} config.schema - JSON Schema for the output
 * @param {string} [config.model='claude-sonnet-4-6']
 * @param {string} [config.effort='high']
 * @param {number} [config.maxBudgetUsd=0.10]
 * @returns {function(string, Object?): Promise<Object>}
 */
export function createStructuredLLMCall(config = {}) {
  const {
    schema,
    model = 'claude-sonnet-4-6',
    effort = 'high',
    maxBudgetUsd = 0.10,
  } = config;

  if (!schema) {
    throw new Error('createStructuredLLMCall requires a schema');
  }

  return async function structuredLLMCall(prompt, variables) {
    const interpolatedPrompt = interpolate(prompt, variables);

    // Prevent nested session detection that causes silent empty responses
    if (process.env.CLAUDECODE) {
      delete process.env.CLAUDECODE;
    }

    const options = {
      model,
      maxTurns: 1,
      effort,
      maxBudgetUsd,
      persistSession: false,
      disallowedTools: ['Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Read'],
      outputFormat: { type: 'json_schema', schema },
    };

    const errorContext = { logger: 'llm-call-structured', model };

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let resultText = '';
        for await (const message of query({ prompt: interpolatedPrompt, options })) {
          if (message.type === 'result') {
            if (message.subtype === 'success') {
              resultText = message.result || '';
            } else {
              const errors = message.errors || [];
              throw new Error(`Structured LLM call failed: ${errors.join(', ') || 'unknown error'}`);
            }
          }
        }
        if (!resultText) {
          throw new Error('Structured LLM call returned empty response');
        }
        return JSON.parse(resultText);
      } catch (err) {
        lastError = err;
        if (isRetryableError(err) && attempt < MAX_RETRIES - 1) {
          const backoff = INITIAL_BACKOFF_MS * (2 ** attempt);
          await sleep(backoff);
          continue;
        }
        classifyAndLogLLMError(err, errorContext);
        throw err;
      }
    }
    classifyAndLogLLMError(lastError, errorContext);
    throw lastError;
  };
}

// ─── Backend 2: OpenCode API Gateway ────────────────────────────────────────

/**
 * Create an LLM call function backed by the OpenCode API gateway.
 * Uses standard OpenAI-compatible chat completions endpoint.
 *
 * @param {Object} [config={}]
 * @param {string} [config.model='kimi-k2.5']
 * @param {string} [config.baseUrl='https://opencode.ai/zen/v1']
 * @param {string} [config.apiKey] - Falls back to process.env.OPENCODE_API_KEY
 * @param {number} [config.temperature=0]
 * @returns {function(string, Object?): Promise<string>}
 */
export function createOpenCodeCall(config = {}) {
  const {
    model = 'kimi-k2.5',
    baseUrl = 'https://opencode.ai/zen/v1',
    apiKey = process.env.OPENCODE_API_KEY,
    temperature = 0,
  } = config;

  return async function openCodeCall(prompt, variables) {
    const interpolatedPrompt = interpolate(prompt, variables);

    const errorContext = { logger: 'opencode-call', model };

    if (!apiKey) {
      const authErr = new Error('OpenCode API key not configured. Set OPENCODE_API_KEY in .env');
      classifyAndLogLLMError(authErr, errorContext);
      throw authErr;
    }

    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: interpolatedPrompt }],
          temperature,
        }),
      });
    } catch (fetchErr) {
      // Network errors (ECONNREFUSED, DNS, timeout, etc.)
      classifyAndLogLLMError(fetchErr, errorContext);
      throw fetchErr;
    }

    if (!response.ok) {
      const body = await response.text();
      const apiErr = new Error(`OpenCode API error ${response.status}: ${body}`);
      classifyAndLogLLMError(apiErr, errorContext);
      throw apiErr;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;

    if (!text) {
      const emptyErr = new Error('OpenCode call returned empty response');
      classifyAndLogLLMError(emptyErr, errorContext);
      throw emptyErr;
    }

    return text;
  };
}

/**
 * Create an LLM call that returns real token logprobs via OpenCode + kimi-k2.5.
 *
 * @param {Object} [config={}]
 * @param {string} [config.model='kimi-k2.5']
 * @param {string} [config.baseUrl='https://opencode.ai/zen/v1']
 * @param {string} [config.apiKey] - Falls back to process.env.OPENCODE_API_KEY
 * @param {number} [config.topLogprobs=5] - Number of top logprobs to return per token
 * @returns {function(string, Object?): Promise<{text: string, logprobs: Array<{token: string, logprob: number}>}>}
 */
export function createOpenCodeLogprobCall(config = {}) {
  const {
    model = 'kimi-k2.5',
    baseUrl = 'https://opencode.ai/zen/v1',
    apiKey = process.env.OPENCODE_API_KEY,
    topLogprobs = 5,
  } = config;

  return async function openCodeLogprobCall(prompt, variables) {
    const interpolatedPrompt = interpolate(prompt, variables);

    const errorContext = { logger: 'opencode-logprob', model };

    if (!apiKey) {
      const authErr = new Error('OpenCode API key not configured. Set OPENCODE_API_KEY in .env');
      classifyAndLogLLMError(authErr, errorContext);
      throw authErr;
    }

    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: interpolatedPrompt }],
          temperature: 0,
          logprobs: true,
          top_logprobs: topLogprobs,
          max_tokens: 10,
        }),
      });
    } catch (fetchErr) {
      classifyAndLogLLMError(fetchErr, errorContext);
      throw fetchErr;
    }

    if (!response.ok) {
      const body = await response.text();
      const apiErr = new Error(`OpenCode logprob API error ${response.status}: ${body}`);
      classifyAndLogLLMError(apiErr, errorContext);
      throw apiErr;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Extract logprobs from the first token's top_logprobs
    const contentLogprobs = data.choices?.[0]?.logprobs?.content;
    let logprobs = [];

    if (contentLogprobs && contentLogprobs.length > 0) {
      const firstToken = contentLogprobs[0];
      // Include the chosen token
      logprobs.push({
        token: firstToken.token,
        logprob: firstToken.logprob,
      });
      // Include alternatives from top_logprobs
      if (firstToken.top_logprobs) {
        for (const alt of firstToken.top_logprobs) {
          if (alt.token !== firstToken.token) {
            logprobs.push({
              token: alt.token,
              logprob: alt.logprob,
            });
          }
        }
      }
    }

    return { text, logprobs };
  };
}

// ─── Self-test ──────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== llm-call.mjs self-test ===\n');

  // Test interpolation
  console.log('--- Test: interpolation ---');
  const t1 = interpolate('Hello {{name}}, you are {{age}}', { name: 'World', age: '42' });
  console.assert(t1 === 'Hello World, you are 42', `Expected interpolation, got: ${t1}`);
  console.log(`  ✓ interpolation: "${t1}"`);

  const t2 = interpolate('No vars here', {});
  console.assert(t2 === 'No vars here', `Expected passthrough, got: ${t2}`);
  console.log(`  ✓ no-op: "${t2}"`);

  const t3 = interpolate('Missing {{unknown}}', { other: 'val' });
  console.assert(t3 === 'Missing {{unknown}}', `Expected preserved placeholder, got: ${t3}`);
  console.log(`  ✓ missing var preserved: "${t3}"`);

  // Test Agent SDK LLM call
  console.log('\n--- Test: Agent SDK LLM call ---');
  try {
    const llmCall = createLLMCall({ model: 'claude-sonnet-4-6', effort: 'low', maxBudgetUsd: 0.02 });
    const result = await llmCall('What is 2 + 2? Reply with just the number, nothing else.');
    console.log(`  ✓ LLM result: "${result.trim()}"`);
    console.assert(result.includes('4'), 'Should contain 4');
  } catch (err) {
    console.log(`  ✗ LLM call error: ${err.message}`);
  }

  // Test OpenCode call (only if API key is available)
  console.log('\n--- Test: OpenCode call ---');
  if (process.env.OPENCODE_API_KEY) {
    try {
      const openCall = createOpenCodeCall();
      const result = await openCall('What is 3 + 3? Reply with just the number.');
      console.log(`  ✓ OpenCode result: "${result.trim()}"`);
    } catch (err) {
      console.log(`  ✗ OpenCode error: ${err.message}`);
    }

    // Test logprob call
    console.log('\n--- Test: OpenCode logprob call ---');
    try {
      const logprobCall = createOpenCodeLogprobCall();
      const { text, logprobs } = await logprobCall('Classify this as one word - Genesis, Custom, Product, or Commodity: Electricity');
      console.log(`  ✓ Text: "${text.trim()}"`);
      console.log(`  ✓ Logprobs (${logprobs.length} entries):`);
      for (const lp of logprobs) {
        console.log(`    ${lp.token}: ${lp.logprob.toFixed(4)}`);
      }
    } catch (err) {
      console.log(`  ✗ Logprob error: ${err.message}`);
    }
  } else {
    console.log('  ⊘ OPENCODE_API_KEY not set, skipping OpenCode tests');
  }

  console.log('\n=== self-test complete ===');
}
