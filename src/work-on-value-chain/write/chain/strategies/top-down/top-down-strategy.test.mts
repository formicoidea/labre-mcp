// End-to-end test for TopDownChainStrategy with a mocked llmCall.
//
// The mock dispatches based on the system prompt content:
//   - if it mentions "extract structured metadata" -> return metadata block
//   - if it mentions "top-down algorithm"          -> return value-chain JSON
//
// Verifies the strategy is registered via the chain registry and that the
// build() method produces a well-formed OWM DSL string.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import '../../../../../lib/prompts/init.mjs';
import { TopDownChainStrategy } from './top-down-strategy.mjs';
import { listStrategies, getStrategy, clearCache } from '../registry.mjs';

function makeMockLlm() {
  // any: mimics the provider-agnostic llmCall signature used by strategies
  return async (user: string, _unused: any, opts: { systemPrompt: string }) => {
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

describe('TopDownChainStrategy', () => {
  before(() => {
    clearCache(); // force re-discovery
  });

  it('registers under write:chain:top-down', async () => {
    const methods = await listStrategies();
    assert.ok(
      methods.includes('write:chain:top-down'),
      `expected write:chain:top-down in registry, got: ${methods.join(', ')}`,
    );
  });

  it('is retrievable via getStrategy', async () => {
    const Cls = await getStrategy('write:chain:top-down');
    assert.equal(Cls.method, 'write:chain:top-down');
    assert.equal(Cls.name, 'TopDownChainStrategy');
  });

  it('requires llmCall in the constructor', () => {
    // any: bypass typed constructor to exercise runtime check
    assert.throws(() => new (TopDownChainStrategy as any)({}),
      /requires an llmCall function/);
  });

  it('rejects an empty nlCommand', async () => {
    const strat = new TopDownChainStrategy({ llmCall: makeMockLlm() });
    await assert.rejects(
      () => strat.build({ nlCommand: '' }),
      /non-empty nlCommand/,
    );
  });

  it('produces OWM DSL for a valid command', async () => {
    const strat = new TopDownChainStrategy({ llmCall: makeMockLlm() });
    const owm = await strat.build({
      nlCommand: 'construis-moi la chaîne de valeur d\'un fournisseur de solution de paiement en ligne',
    });
    assert.ok(owm.startsWith('title Value chain of an online payment provider'));
    assert.ok(owm.includes('style plain'));
    assert.ok(owm.includes('anchor Merchant '));
    assert.ok(owm.includes('component Accept Payment '));
    assert.ok(owm.includes('component Fraud '));
    assert.ok(!owm.includes('"Accept Payment"'),
      'multi-word names must not be quoted in chain output');
    assert.ok(owm.includes('Merchant->Accept Payment'));
    assert.ok(owm.includes('// angle: strategic positioning'));
  });

  it('honours the emit.style option', async () => {
    const strat = new TopDownChainStrategy({ llmCall: makeMockLlm() });
    const owm = await strat.build({
      nlCommand: 'construis-moi la chaîne de valeur d\'un fournisseur de solution de paiement en ligne',
      emit: { style: 'colour' },
    });
    assert.ok(owm.includes('style colour'));
    assert.ok(!owm.includes('style plain'));
  });

  it('buildFull returns owm and metadata together', async () => {
    const strat = new TopDownChainStrategy({ llmCall: makeMockLlm() });
    const full = await strat.buildFull({
      nlCommand: 'construis-moi la chaîne de valeur d\'un fournisseur de solution de paiement en ligne',
    });
    assert.ok(full.owm.includes('anchor Merchant'));
    assert.equal(full.metadata.title, 'Value chain of an online payment provider');
    assert.equal(full.metadata.angle, 'strategic positioning');
    assert.equal(full.metadata.scope, 'online payment processing');
    assert.equal(full.metadata.temporality, 'present');
    assert.deepEqual(full.metadata.imperatives, []);
    assert.equal(full.metadata.contextSummary, 'Online payment provider.');
  });
});
