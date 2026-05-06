// Canonical list of MCP strategies/capabilities that call an LLM, paired with
// the capability each one requires. Used by the registry to validate at load
// time that the provider assigned to each strategy actually supports what it needs.

import type { LLMCapability } from './providers/provider.types.mjs';

export const STRATEGY_CAPABILITIES = {
  'publication-analysis': 'text',
  'timeline-benchmark':   'text',
  'llm-direct':           'text',
  'cpc-evolution':        'text',
  'cpc-mapper':           'text',
  'logprob-distribution': 'logprobs',
  'properties-strategy':  'text',
  'anchor-evolution':     'text',
  'identify-capability':  'text',
  'dual-verification':    'text',
  'pipeline-enrichment':  'text',
  'write-chain':          'text',
} as const satisfies Record<string, LLMCapability>;

export type StrategyId = keyof typeof STRATEGY_CAPABILITIES;

export const STRATEGY_IDS = Object.keys(STRATEGY_CAPABILITIES) as StrategyId[];
