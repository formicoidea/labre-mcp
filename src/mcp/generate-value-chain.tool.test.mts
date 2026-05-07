// Tests for the generateValueChain MCP tool definition + handler.
//
// The handler reaches into the LLM registry to resolve `write-chain`; we
// override that lookup via setLLMCallForTesting so the test does not make
// real network calls.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/prompts/init.mjs';
import {
  GENERATE_VALUE_CHAIN_TOOL,
  handleGenerateValueChain,
} from './generate-value-chain.tool.mjs';
import {
  setLLMCallForTesting,
  resetLLMRegistryCache,
} from '../lib/llm/registry.mjs';

// any: mimics the provider-agnostic llmCall signature
function makeMockLlm() {
  return async (_user: string, _unused: any, opts: { systemPrompt: string }) => {
    const sys = opts.systemPrompt ?? '';
    if (sys.includes('extract structured metadata')) {
      return [
        'title=Value chain of an online payment provider',
        'angle=strategic positioning',
        'scope=online payment processing',
        'objective=map the value chain',
        'imperatives=none',
        'temporality=present',
        'contextSummary=Online payment provider.',
      ].join('\n');
    }
    if (sys.includes('Top-down algorithm')) {
      return JSON.stringify({
        components: [
          { name: 'Merchant',       type: 'anchor',    role: 'anchor', xHint: 0.75 },
          { name: 'Accept Payment', type: 'component', role: 'need', xHint: 0.60 },
          { name: 'Fraud',          type: 'component', role: 'capability', xHint: 0.30 },
        ],
        links: [
          { from: 'Merchant',       to: 'Accept Payment' },
          { from: 'Accept Payment', to: 'Fraud' },
        ],
      });
    }
    throw new Error(`unexpected system prompt: ${sys.slice(0, 50)}`);
  };
}

describe('GENERATE_VALUE_CHAIN_TOOL', () => {
  it('declares the expected MCP tool name', () => {
    assert.equal(GENERATE_VALUE_CHAIN_TOOL.name, 'generateValueChain');
  });

  it('declares an input schema requiring nlCommand', () => {
    const schema = GENERATE_VALUE_CHAIN_TOOL.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.ok(schema.properties && 'nlCommand' in schema.properties,
      'inputSchema should declare nlCommand');
    assert.ok(schema.required?.includes('nlCommand'),
      'nlCommand should be marked required');
  });
});

describe('handleGenerateValueChain', () => {
  before(() => {
    resetLLMRegistryCache();
    setLLMCallForTesting('write-chain', 'text', makeMockLlm());
  });

  after(() => {
    resetLLMRegistryCache();
  });

  it('returns owm, metadata and method', async () => {
    const result = await handleGenerateValueChain({
      nlCommand: 'construis-moi la chaîne de valeur d\'un fournisseur de solution de paiement en ligne',
    });
    assert.equal(result.method, 'write:chain:top-down');
    assert.ok(typeof result.owm === 'string' && result.owm.length > 0);
    assert.ok(result.owm.startsWith('title Value chain of an online payment provider'));
    assert.ok(result.owm.includes('style plain'));
    assert.ok(result.owm.includes('anchor Merchant '));
    assert.ok(result.owm.includes('component Accept Payment '));
    assert.ok(!result.owm.includes('"Accept Payment"'));
    assert.ok(result.owm.includes('Merchant->Accept Payment'));
    assert.equal(result.metadata.title, 'Value chain of an online payment provider');
    assert.equal(result.metadata.angle, 'strategic positioning');
    assert.equal(result.metadata.scope, 'online payment processing');
    assert.equal(result.metadata.temporality, 'present');
    assert.deepEqual(result.metadata.imperatives, []);
  });

  it('rejects input with missing nlCommand', async () => {
    await assert.rejects(
      () => handleGenerateValueChain({}),
      /nlCommand/,
    );
  });

  it('rejects empty nlCommand', async () => {
    await assert.rejects(
      () => handleGenerateValueChain({ nlCommand: '' }),
      /too_small|nlCommand/,
    );
  });
});
