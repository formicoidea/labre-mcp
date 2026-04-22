// Eagerly register every custom parser declared in prompts.config.json.
//
// Import this module at process startup (mcp-server.mts) or at the top of any
// test file that exercises getPrompt(...).parse(). Registration is a pure
// side-effect: the module registers once (ESM caches the import) and throws
// on duplicate registration.
//
// The list below is the single source of truth mapping parser ids from
// prompts.config.json to their TypeScript implementation. Any change to
// prompts.config.json that adds/removes/renames a parser.id must be
// reflected here — otherwise getPrompt().parse() will throw at runtime with
// "parser 'X' is not registered".

import { registerParser } from './parsers-registry.mjs';

import { parseCapabilityResponse } from '../../work-on-value-chain/write/component/identify-capability.mjs';
import { parseAnchorResponse } from '../../work-on-evolution/strategies/anchor/estimate-anchor-evolution.mjs';
import { parsePubResponse } from '../../work-on-evolution/strategies/capacity/publication-analysis-strategy.mjs';
import { parseFallbackPhase } from '../../work-on-evolution/strategies/capacity/logprob-distribution-strategy.mjs';
import { parseHistoryIterationResponse } from '../../work-on-evolution/strategies/capacity/timeline-benchmark-strategy.mjs';
import { parseLLMDirectResponse } from '../../work-on-evolution/strategies/capacity/llm-direct-strategy.mjs';
import {
  parseCpcPickClass,
  parseCpcPickFromList,
  parseCpcFallback,
} from '../../work-on-evolution/patent/cpc-mapper.mjs';
import { parseCpcSotExtraction } from '../../work-on-evolution/strategies/capacity/cpc-evolution-strategy.mjs';
import { parseSolutionDiscoveryResponse } from '../../work-on-evolution/pipeline/pipeline-enriched.mjs';
import { parseWebSearchResponse } from '../../work-on-value-chain/write/component/web-search-verification.mjs';
import { parseLLMClassificationResponse } from '../../work-on-evolution/routing/detect-solution.mjs';
import {
  parseAutoResponse,
  parseSinglePropertyResponse,
} from '../../work-on-evolution/strategies/solution/properties-strategy.mjs';

registerParser('cpcSotExtraction',      parseCpcSotExtraction);
registerParser('identifyCapability',    parseCapabilityResponse);
registerParser('anchorEvolution',       parseAnchorResponse);
registerParser('publicationPhases',     parsePubResponse);
registerParser('logprobFallback',       parseFallbackPhase);
registerParser('timelineIteration',     parseHistoryIterationResponse);
registerParser('llmDirect',             parseLLMDirectResponse);
registerParser('cpcPickClass',          parseCpcPickClass);
registerParser('cpcPickFromList',       parseCpcPickFromList);
registerParser('cpcFallback',           parseCpcFallback);
registerParser('solutionDiscovery',     parseSolutionDiscoveryResponse);
registerParser('webSearchVerification', parseWebSearchResponse);
registerParser('solutionClassification', parseLLMClassificationResponse);
registerParser('propertiesAuto',        parseAutoResponse);
registerParser('propertiesSingle',      parseSinglePropertyResponse);
