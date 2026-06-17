// GitHub Copilot SDK call primitives.
//
// Mirrors the contract of llm-call.mts (createLLMCall / createStructuredLLMCall)
// so the registry can treat Copilot SDK strategies identically to Claude Agent
// SDK ones. Same retry envelope, same interpolation helper, same error handler.
//
// Structured output uses "voie B": the prompt carries the JSON Schema, the
// model replies with free-form text, we strip markdown fences, JSON.parse, and
// optionally Zod-validate on the caller side. On parse failure a single retry
// appends a correction instruction before re-asking.
//
// The Copilot SDK exposes no logprobs — strategies needing logprobs must route
// to a provider whose API response includes them (e.g. the `http-api` kind).

// any: the public preview of @github/copilot-sdk ships without exported types
// for session event payloads. We touch only the fields we rely on at runtime.
import { createRequire } from 'node:module';
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import { classifyAndLogLLMError } from './llm-error-handler.mjs';
import type {
  LLMCall,
  StructuredLLMCall,
  TemplateVariables,
} from '../../types/llm.mjs';

// ─── Retry Configuration (aligned with llm-call.mts) ────────────────────────

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;
const RETRYABLE_PATTERNS = [
  'concurrency', 'rate', 'timeout', 'overloaded',
  'temporarily', 'empty response', 'need retry', 'startup',
  'unknown error',
];

const requireFromHere = createRequire(import.meta.url);

function isRetryableError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return RETRYABLE_PATTERNS.some(p => msg.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Template Interpolation (duplicated from llm-call.mts; kept local to  ───
// keep this file self-contained — extract to a shared module if a third    ───
// provider ends up needing it) ───────────────────────────────────────────────

export function interpolate(template: string, variables?: TemplateVariables): string {
  if (!variables || Object.keys(variables).length === 0) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return variables[key] !== undefined ? String(variables[key]) : match;
  });
}

// ─── Config shapes ──────────────────────────────────────────────────────────

export interface CopilotSdkTextConfig {
  /** Copilot CLI model id (e.g. 'gpt-5', 'claude-sonnet-4-6'). */
  model?: string;
  /** Optional GitHub auth token. Falls back to the SDK's own resolution
   *  (gh auth login / GH_TOKEN / GITHUB_TOKEN) when unset. */
  githubToken?: string;
  /** Optional system-style preamble prepended to the user prompt. */
  systemPrompt?: string;
}

export interface CopilotSdkStructuredConfig<T = unknown> extends CopilotSdkTextConfig {
  /** JSON Schema embedded in the prompt as the output contract. */
  schema: Record<string, unknown>;
  /** Optional runtime validator. If provided, the parsed JSON is passed through
   *  it; a failure triggers the same single retry as a JSON.parse failure. */
  validate?: (value: unknown) => T;
}

export interface CopilotCliCheckResult {
  ready: boolean;
  reason?: string;
}

export function checkCopilotCliAvailable(
  resolvePackage: (specifier: string) => string = (specifier) => requireFromHere.resolve(specifier),
): CopilotCliCheckResult {
  try {
    resolvePackage('@github/copilot/package.json');
    return { ready: true };
  } catch (err) {
    return {
      ready: false,
      reason:
        '@github/copilot CLI package is not installed. Install @github/copilot or choose a different LLM provider.',
    };
  }
}

// ─── Single-turn session runner ─────────────────────────────────────────────

async function runSingleTurn(
  client: CopilotClient,
  model: string,
  userPrompt: string,
  systemPrompt?: string,
): Promise<string> {
  // any: SessionConfig.systemMessage is part of the SDK public preview surface.
  // When a systemPrompt is provided we use `replace` mode so the caller's
  // content fully controls the system message — the SDK's default CLI foundation
  // (code-change rules, tool-efficiency guardrails, etc.) is not meaningful for
  // pure evaluation calls and would leak into the model's framing.
  const sessionConfig: any = {
    model,
    onPermissionRequest: approveAll,
  };
  if (systemPrompt) {
    sessionConfig.systemMessage = { mode: 'replace', content: systemPrompt };
  }
  const session = await client.createSession(sessionConfig);

  let fullText = '';
  let errorFromSession: unknown = null;

  const done = new Promise<void>((resolve) => {
    // any: event payload shape is `{ data: { content: string, ... } }` at runtime.
    session.on('assistant.message', (event: any) => {
      const chunk: string = event?.data?.content ?? '';
      fullText += chunk;
    });
    session.on('session.error', (event: any) => {
      errorFromSession = new Error(
        `Copilot session error: ${event?.data?.message ?? 'unknown error'}`,
      );
      resolve();
    });
    session.on('session.idle', () => resolve());
  });

  try {
    await session.send({ prompt: userPrompt });
    await done;
  } finally {
    try {
      await session.disconnect();
    } catch {
      // disconnect errors shouldn't mask the real one
    }
  }

  if (errorFromSession) throw errorFromSession;
  if (!fullText) throw new Error('Copilot SDK call returned empty response');
  return fullText;
}

async function withClient<T>(
  githubToken: string | undefined,
  run: (client: CopilotClient) => Promise<T>,
): Promise<T> {
  // any: constructor options shape is part of the SDK's public preview surface.
  const clientOptions: any = githubToken
    ? { githubToken }
    : { useLoggedInUser: true };

  const client = new CopilotClient(clientOptions);
  await client.start();
  try {
    return await run(client);
  } finally {
    try {
      await client.stop();
    } catch {
      // stop errors shouldn't mask the real one
    }
  }
}

// ─── Public factories ───────────────────────────────────────────────────────

export function createCopilotSdkTextCall(config: CopilotSdkTextConfig = {}): LLMCall {
  const {
    model = 'gpt-5',
    githubToken,
    systemPrompt: factorySystemPrompt,
  } = config;

  return async function copilotSdkTextCall(prompt, variables, opts) {
    const interpolated = interpolate(prompt, variables);
    const effectiveSystemPrompt = opts?.systemPrompt ?? factorySystemPrompt;

    const errorContext = { logger: 'copilot-sdk-call', model };

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await withClient(githubToken, (client) =>
          runSingleTurn(client, model, interpolated, effectiveSystemPrompt),
        );
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

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

export function createCopilotSdkStructuredCall<T = unknown>(
  config: CopilotSdkStructuredConfig<T>,
): StructuredLLMCall<T> {
  const {
    schema,
    model = 'gpt-5',
    githubToken,
    systemPrompt: factorySystemPrompt,
    validate,
  } = config;

  if (!schema) {
    throw new Error('createCopilotSdkStructuredCall requires a schema');
  }

  const schemaJson = JSON.stringify(schema, null, 2);
  const outputContract =
    `Respond ONLY with a single JSON object matching this JSON Schema. ` +
    `No prose, no markdown, no code fences.\n\n${schemaJson}`;

  return async function copilotSdkStructuredCall(prompt, variables, opts) {
    const interpolated = interpolate(prompt, variables);
    const effectiveSystemPrompt = opts?.systemPrompt ?? factorySystemPrompt;
    // The output contract is strategy-static (same schema each call) and
    // belongs in the system message so the user message stays minimal.
    const systemForCall = effectiveSystemPrompt
      ? `${effectiveSystemPrompt}\n\n${outputContract}`
      : outputContract;

    const errorContext = { logger: 'copilot-sdk-call-structured', model };

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // 1st network attempt of this retry cycle.
        const raw = await withClient(githubToken, (client) =>
          runSingleTurn(client, model, interpolated, systemForCall),
        );

        const parsed = tryParseAndValidate<T>(raw, validate);
        if (parsed.ok) return parsed.value;

        // 2nd attempt in the same retry cycle: ask the model to correct itself.
        const correctionUserPrompt =
          `${interpolated}\n\n` +
          `Your previous response was not a valid JSON object ` +
          `matching the schema (reason: ${parsed.reason}). ` +
          `Return ONLY the JSON object, no prose, no code fences.`;

        const rawRetry = await withClient(githubToken, (client) =>
          runSingleTurn(client, model, correctionUserPrompt, systemForCall),
        );

        const parsedRetry = tryParseAndValidate<T>(rawRetry, validate);
        if (parsedRetry.ok) return parsedRetry.value;

        throw new Error(
          `Copilot SDK structured call failed after in-cycle correction: ${parsedRetry.reason}`,
        );
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

type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function tryParseAndValidate<T>(
  raw: string,
  validate?: (value: unknown) => T,
): ParseOutcome<T> {
  const cleaned = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, reason: `JSON.parse: ${(err as Error).message}` };
  }
  if (!validate) return { ok: true, value: parsed as T };
  try {
    return { ok: true, value: validate(parsed) };
  } catch (err) {
    return { ok: false, reason: `validation: ${(err as Error).message}` };
  }
}
