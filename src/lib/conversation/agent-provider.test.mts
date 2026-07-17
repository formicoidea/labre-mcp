// Unit tests for the per-turn agent provider drivers (ADR-0028, PR-A4-4):
// driver selection by provider, wire shape per driver (endpoint + auth
// header), base_url hygiene, and the no-secret-in-errors guarantee. A mocked
// global fetch stands in for the providers — no network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentProviderCall,
  providerErrorNotice,
  PROVIDER_CONFIG_NOTICE,
  type AgentProviderConfig,
} from './agent-provider.mjs';
import { runWithUsageCollector, type LlmUsageAggregate } from '#lib/llm/usage-context.mjs';

const SECRET = 'sk-test-EXTREMELY-SECRET';

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

/** Run `fn` with a stubbed global fetch; returns the captured calls. */
async function withFetch(
  respond: (url: string) => Response,
  fn: () => Promise<void>,
): Promise<CapturedFetch[]> {
  const calls: CapturedFetch[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

function anthropicOk(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 42, output_tokens: 7 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function chatCompletionsOk(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = (init.headers ?? {}) as Record<string, string>;
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

describe('createAgentProviderCall — driver selection', () => {
  it('anthropic → Messages API with x-api-key + anthropic-version, usage recorded', async () => {
    const config: AgentProviderConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      baseUrl: null,
      secret: SECRET,
    };
    let usage: LlmUsageAggregate = { llmCalls: 0 };
    let text = '';

    const calls = await withFetch(
      () => anthropicOk('bonjour'),
      async () => {
        const llm = createAgentProviderCall(config);
        text = await runWithUsageCollector(
          () => llm('say hi', undefined, { systemPrompt: 'be brief' }),
          (aggregate) => {
            usage = aggregate;
          },
        );
      },
    );

    assert.equal(text, 'bonjour');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(headerOf(calls[0].init, 'x-api-key'), SECRET);
    assert.equal(headerOf(calls[0].init, 'anthropic-version'), '2023-06-01');
    assert.equal(headerOf(calls[0].init, 'authorization'), undefined);

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert.equal(body.model, 'claude-sonnet-4-6');
    assert.equal(body.system, 'be brief');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'say hi' }]);
    assert.equal(typeof body.max_tokens, 'number');

    // Usage flows through the collector for the spend ledger.
    assert.equal(usage.llmCalls, 1);
    assert.equal(usage.inputTokens, 42);
    assert.equal(usage.outputTokens, 7);
    assert.equal(usage.model, 'claude-sonnet-4-6');
  });

  it('openai → Chat Completions on api.openai.com with Bearer secret', async () => {
    const config: AgentProviderConfig = {
      provider: 'openai',
      model: 'gpt-x',
      baseUrl: null,
      secret: SECRET,
    };
    let text = '';
    const calls = await withFetch(
      () => chatCompletionsOk('hello'),
      async () => {
        const llm = createAgentProviderCall(config);
        text = await llm('say hi');
      },
    );
    assert.equal(text, 'hello');
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(headerOf(calls[0].init, 'authorization'), `Bearer ${SECRET}`);
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert.equal(body.model, 'gpt-x');
  });

  it('openai-compatible → Chat Completions on the per-turn base_url (trailing slash tolerated)', async () => {
    const config: AgentProviderConfig = {
      provider: 'openai-compatible',
      model: 'local-model',
      baseUrl: 'https://llm.example.com/v1/',
      secret: SECRET,
    };
    const calls = await withFetch(
      () => chatCompletionsOk('ok'),
      async () => {
        const llm = createAgentProviderCall(config);
        await llm('ping');
      },
    );
    assert.equal(calls[0].url, 'https://llm.example.com/v1/chat/completions');
    assert.equal(headerOf(calls[0].init, 'authorization'), `Bearer ${SECRET}`);
  });
});

describe('createAgentProviderCall — base_url hygiene', () => {
  it('openai-compatible without a base_url refuses at construction', () => {
    const config: AgentProviderConfig = {
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: null,
      secret: SECRET,
    };
    assert.throws(() => createAgentProviderCall(config), /base_url is required/);
  });

  it('a credential-carrying base_url is refused WITHOUT echoing it', () => {
    const config: AgentProviderConfig = {
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'https://user:hunter2@llm.example.com/v1',
      secret: SECRET,
    };
    try {
      createAgentProviderCall(config);
      assert.fail('expected a throw');
    } catch (err) {
      const message = (err as Error).message;
      assert.match(message, /must not embed credentials/);
      assert.ok(!message.includes('hunter2'), 'the embedded password must not be echoed');
      assert.ok(!message.includes('llm.example.com'), 'the URL itself must not be echoed');
    }
  });

  it('a malformed base_url is refused without echoing it', () => {
    const config: AgentProviderConfig = {
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'not a url at all',
      secret: SECRET,
    };
    assert.throws(() => createAgentProviderCall(config), /not a valid URL/);
  });

  it('a plain-http base_url is refused (the secret would ride it in clear)', () => {
    const config: AgentProviderConfig = {
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'http://llm.example.com/v1',
      secret: SECRET,
    };
    try {
      createAgentProviderCall(config);
      assert.fail('expected a throw');
    } catch (err) {
      const message = (err as Error).message;
      assert.match(message, /must use https/);
      assert.ok(!message.includes('llm.example.com'), 'the URL itself must not be echoed');
    }
  });

  it('http is tolerated for localhost dev targets only', () => {
    for (const baseUrl of ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1']) {
      const config: AgentProviderConfig = {
        provider: 'openai-compatible',
        model: 'm',
        baseUrl,
        secret: SECRET,
      };
      assert.doesNotThrow(() => createAgentProviderCall(config), `${baseUrl} must be accepted`);
    }
  });

  it('a query string or fragment is refused (it would mangle the endpoint silently)', () => {
    // `${baseUrl}/chat/completions` on 'https://h/v1?tenant=9' yields
    // 'https://h/v1?tenant=9/chat/completions' — the query swallows the path.
    for (const baseUrl of ['https://llm.example.com/v1?tenant=9', 'https://llm.example.com/v1#x']) {
      const config: AgentProviderConfig = {
        provider: 'openai-compatible',
        model: 'm',
        baseUrl,
        secret: SECRET,
      };
      assert.throws(() => createAgentProviderCall(config), /query string or fragment/);
    }
  });
});

describe('createAgentProviderCall — provider errors carry no secret', () => {
  it('anthropic 401: the thrown message names the status, never the key', async () => {
    const config: AgentProviderConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      baseUrl: null,
      secret: SECRET,
    };
    await withFetch(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }), {
          status: 401,
        }),
      async () => {
        const llm = createAgentProviderCall(config);
        try {
          await llm('hi');
          assert.fail('expected a throw');
        } catch (err) {
          const message = (err as Error).message;
          assert.match(message, /Anthropic API error 401/);
          assert.ok(!message.includes(SECRET), 'the secret must never appear in errors');
        }
      },
    );
  });

  it('anthropic empty completion throws (observable, not silent)', async () => {
    const config: AgentProviderConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      baseUrl: null,
      secret: SECRET,
    };
    await withFetch(
      () =>
        new Response(JSON.stringify({ content: [], usage: {} }), {
          status: 200,
        }),
      async () => {
        const llm = createAgentProviderCall(config);
        await assert.rejects(llm('hi'), /empty response/);
      },
    );
  });
});

describe('providerErrorNotice — sanitized, class-only member copy', () => {
  it('maps error classes to static prose without echoing err.message', () => {
    const auth = providerErrorNotice(new Error('API error 401: secret-ish body sk-live-XYZ'));
    assert.match(auth, /rejected the configured API key/);
    assert.ok(!auth.includes('sk-live-XYZ'), 'notice never quotes the raw error');

    assert.match(providerErrorNotice(new Error('status 429 too many requests')), /rate-limiting/);
    assert.match(providerErrorNotice(new Error('request timed out')), /timed out/);
    assert.match(providerErrorNotice(new Error('fetch failed')), /could not be reached/);
    assert.match(
      providerErrorNotice(new Error('call returned empty response')),
      /empty response/,
    );
    assert.match(providerErrorNotice(new Error('API error 503: nope')), /HTTP 503/);
    assert.match(providerErrorNotice(new Error('???')), /could not reply/);
  });

  it('the config notice is static prose', () => {
    assert.match(PROVIDER_CONFIG_NOTICE, /provider configuration could not be read/);
  });
});
