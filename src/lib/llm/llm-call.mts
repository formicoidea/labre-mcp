// Generic LLM call module — multi-backend support.
//
// Two backends:
//   1. Claude Agent SDK (default) — for text completion, no logprobs
//   2. OpenCode API gateway — for kimi-k2.5 with real logprobs
//
// Usage:
//   import { createLLMCall, createOpenCodeLogprobCall } from './llm-call.mjs';
//   const llmCall = createLLMCall();
//   const text = await llmCall('Analyze {{component}}', { component: 'ERP' });
//
//   const logprobCall = createOpenCodeLogprobCall();
//   const { text, logprobs } = await logprobCall('Classify {{component}}', { component: 'ERP' });

import { query } from '@anthropic-ai/claude-agent-sdk';
import { classifyAndLogLLMError } from './llm-error-handler.mjs';
import type {
  LLMCall,
  StructuredLLMCall,
  LogprobLLMCall,
  LogprobResult,
  ClaudeLLMConfig,
  StructuredLLMConfig,
  OpenCodeConfig,
  OpenCodeLogprobConfig,
  TemplateVariables,
} from '../../types/llm.mjs';

// ─── Retry Configuration (aligned with Ouroboros claude_code_adapter) ───────

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;
const RETRYABLE_PATTERNS = [
  'concurrency', 'rate', 'timeout', 'overloaded',
  'temporarily', 'empty response', 'need retry', 'startup',
  'unknown error',
];

function isRetryableError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return RETRYABLE_PATTERNS.some(p => msg.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Template Interpolation ─────────────────────────────────────────────────

/** Replace {{variable}} placeholders in a template string. */
export function interpolate(template: string, variables?: TemplateVariables): string {
  if (!variables || Object.keys(variables).length === 0) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return variables[key] !== undefined ? String(variables[key]) : match;
  });
}

// ─── Backend 1: Claude Agent SDK ────────────────────────────────────────────

/**
 * Create a reusable LLM call function backed by the Claude Agent SDK.
 * Uses query() with tools disabled for pure text completion.
 */
export function createLLMCall(config: ClaudeLLMConfig = {}): LLMCall {
  const {
    model = 'claude-sonnet-4-6',
    effort = 'high',
    systemPrompt: factorySystemPrompt,
  } = config;

  return async function llmCall(prompt, variables, opts) {
    const interpolatedPrompt = interpolate(prompt, variables);
    // Per-call opts.systemPrompt wins over factory-level config.systemPrompt.
    // This lets split-prompt call-sites carry the .system.md content while
    // leaving factory-level overrides available for strategies that don't.
    const effectiveSystemPrompt = opts?.systemPrompt ?? factorySystemPrompt;

    // Prevent nested session detection that causes silent empty responses
    if (process.env.CLAUDECODE) {
      delete process.env.CLAUDECODE;
    }

    const options: Record<string, unknown> = {
      model,
      maxTurns: 1,
      effort,
      persistSession: false,
      disallowedTools: ['Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Read'],
    };

    if (effectiveSystemPrompt) {
      options.systemPrompt = effectiveSystemPrompt;
    }

    const errorContext = { logger: 'llm-call', model };

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let resultText = '';
        for await (const message of query({ prompt: interpolatedPrompt, options } as Parameters<typeof query>[0])) {
          const msg = message as { type: string; subtype?: string; result?: string; errors?: string[] };
          if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              resultText = msg.result || '';
            } else {
              const errors = msg.errors || [];
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

/** Create an LLM call that returns structured JSON via the Agent SDK. */
export function createStructuredLLMCall<T = unknown>(
  config: StructuredLLMConfig,
): StructuredLLMCall<T> {
  const {
    schema,
    model = 'claude-sonnet-4-6',
    effort = 'high',
    systemPrompt: factorySystemPrompt,
  } = config;

  if (!schema) {
    throw new Error('createStructuredLLMCall requires a schema');
  }

  return async function structuredLLMCall(prompt, variables, opts) {
    const interpolatedPrompt = interpolate(prompt, variables);
    const effectiveSystemPrompt = opts?.systemPrompt ?? factorySystemPrompt;

    if (process.env.CLAUDECODE) {
      delete process.env.CLAUDECODE;
    }

    const options: Record<string, unknown> = {
      model,
      maxTurns: 1,
      effort,
      persistSession: false,
      disallowedTools: ['Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Read'],
      outputFormat: { type: 'json_schema', schema },
    };

    if (effectiveSystemPrompt) {
      options.systemPrompt = effectiveSystemPrompt;
    }

    const errorContext = { logger: 'llm-call-structured', model };

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let resultText = '';
        for await (const message of query({ prompt: interpolatedPrompt, options } as Parameters<typeof query>[0])) {
          const msg = message as { type: string; subtype?: string; result?: string; errors?: string[] };
          if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              resultText = msg.result || '';
            } else {
              const errors = msg.errors || [];
              throw new Error(`Structured LLM call failed: ${errors.join(', ') || 'unknown error'}`);
            }
          }
        }
        if (!resultText) {
          throw new Error('Structured LLM call returned empty response');
        }
        return JSON.parse(resultText) as T;
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
 */
export function createOpenCodeCall(config: OpenCodeConfig = {}): LLMCall {
  const {
    model = 'kimi-k2.5',
    baseUrl = 'https://opencode.ai/zen/v1',
    apiKey = process.env.OPENCODE_API_KEY,
    temperature = 0,
    systemPrompt: factorySystemPrompt,
  } = config;

  return async function openCodeCall(prompt, variables, opts) {
    const interpolatedPrompt = interpolate(prompt, variables);
    const effectiveSystemPrompt = opts?.systemPrompt ?? factorySystemPrompt;

    const errorContext = { logger: 'opencode-call', model };

    if (!apiKey) {
      const authErr = new Error('OpenCode API key not configured. Set OPENCODE_API_KEY in .env');
      classifyAndLogLLMError(authErr, errorContext);
      throw authErr;
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (effectiveSystemPrompt) {
      messages.push({ role: 'system', content: effectiveSystemPrompt });
    }
    messages.push({ role: 'user', content: interpolatedPrompt });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
        }),
      });
    } catch (fetchErr) {
      classifyAndLogLLMError(fetchErr, errorContext);
      throw fetchErr;
    }

    if (!response.ok) {
      const body = await response.text();
      const apiErr = new Error(`OpenCode API error ${response.status}: ${body}`);
      classifyAndLogLLMError(apiErr, errorContext);
      throw apiErr;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;

    if (!text) {
      const emptyErr = new Error('OpenCode call returned empty response');
      classifyAndLogLLMError(emptyErr, errorContext);
      throw emptyErr;
    }

    return text;
  };
}

/** Create an LLM call that returns real token logprobs via OpenCode + kimi-k2.5. */
export function createOpenCodeLogprobCall(
  config: OpenCodeLogprobConfig = {},
): LogprobLLMCall {
  const {
    model = 'kimi-k2.5',
    baseUrl = 'https://opencode.ai/zen/v1',
    apiKey = process.env.OPENCODE_API_KEY,
    topLogprobs = 5,
    systemPrompt: factorySystemPrompt,
  } = config;

  return async function openCodeLogprobCall(prompt, variables, opts): Promise<LogprobResult> {
    const interpolatedPrompt = interpolate(prompt, variables);
    const effectiveSystemPrompt = opts?.systemPrompt ?? factorySystemPrompt;

    const errorContext = { logger: 'opencode-logprob', model };

    if (!apiKey) {
      const authErr = new Error('OpenCode API key not configured. Set OPENCODE_API_KEY in .env');
      classifyAndLogLLMError(authErr, errorContext);
      throw authErr;
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (effectiveSystemPrompt) {
      messages.push({ role: 'system', content: effectiveSystemPrompt });
    }
    messages.push({ role: 'user', content: interpolatedPrompt });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
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

    const data = await response.json() as {
      choices?: Array<{
        message?: { content?: string };
        logprobs?: {
          content?: Array<{
            token: string;
            logprob: number;
            top_logprobs?: Array<{ token: string; logprob: number }>;
          }>;
        };
      }>;
    };
    const text = data.choices?.[0]?.message?.content || '';

    const contentLogprobs = data.choices?.[0]?.logprobs?.content;
    const logprobs: LogprobResult['logprobs'] = [];

    if (contentLogprobs && contentLogprobs.length > 0) {
      const firstToken = contentLogprobs[0];
      logprobs.push({
        token: firstToken.token,
        logprob: firstToken.logprob,
      });
      if (firstToken.top_logprobs) {
        for (const alt of firstToken.top_logprobs) {
          if (alt.token !== firstToken.token) {
            logprobs.push({ token: alt.token, logprob: alt.logprob });
          }
        }
      }
    }

    return { text, logprobs };
  };
}
