// WardleyAssistant — main entry point
//
// Re-exports the public API surface for programmatic consumers.
// For MCP server usage, run: node src/mcp-server.mjs

// ─── MCP Server ─────────────────────────────────────────────────────────────
export { startServer, REGISTERED_TOOLS, TOOL_HANDLERS, handleRequest } from './mcp/mcp-server.mjs';

// ─── Tools ──────────────────────────────────────────────────────────────────
export { ESTIMATE_EVOLUTION_TOOL, handleEstimateEvolution } from './mcp/mcp-tool.mjs';
export { GENERATE_VALUE_CHAIN_TOOL, handleGenerateValueChain } from './work-on-value-chain/generate-value-chain.mjs';
export { EVALUATE_MAP_TOOL, handleEvaluateMap } from './work-on-evolution/evaluate-map/evaluate-map.mjs';
export { IDENTIFY_CAPABILITY_TOOL, handleIdentifyCapability } from './work-on-value-chain/identify-capability.mjs';
export { ESTIMATE_ANCHOR_EVOLUTION_TOOL, handleEstimateAnchorEvolution } from './work-on-evolution/strategies/anchor/estimate-anchor-evolution.mjs';

// ─── Strategy Registry ──────────────────────────────────────────────────────
export { loadStrategies, getStrategy, listStrategies } from './work-on-evolution/strategies/capacity/registry.mjs';

// ─── Routing ────────────────────────────────────────────────────────────────
export { classifyComponent } from './work-on-evolution/routing/classification-gate.mjs';
export { detectMode, routeEstimateEvolution } from './work-on-evolution/routing/mode-router.mjs';

// ─── Shared Utilities ───────────────────────────────────────────────────────
export { createLLMCall, createStructuredLLMCall } from './lib/llm/llm-call.mjs';
export { detectLanguage } from './lib/language-detect.mjs';
export { formatResponse } from './lib/response-formatter.mjs';
