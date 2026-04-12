// Auto-discovery proxy for CPC Evolution Strategy
//
// The registry scans src/strategies/*-strategy.mjs for classes extending BaseStrategy.
// The actual implementation lives in src/patent/cpc-evolution-strategy.mjs.
// This file re-exports the class so the plugin system auto-discovers it.

export { CpcEvolutionStrategy } from '../../patent/cpc-evolution-strategy.mjs';
