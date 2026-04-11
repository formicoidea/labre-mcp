// WardleyAssistant — main entry point
//
// Re-exports the public API surface for programmatic consumers.
// For MCP server usage, run: node src/mcp-server.mjs

// ─── MCP Server ─────────────────────────────────────────────────────────────
export { startServer, REGISTERED_TOOLS, TOOL_HANDLERS, handleRequest } from './mcp/mcp-server.mjs';

// ─── Tools ──────────────────────────────────────────────────────────────────
export { ESTIMATE_EVOLUTION_TOOL, handleEstimateEvolution } from './mcp/mcp-tool.mjs';
export { GENERATE_VALUE_CHAIN_TOOL, handleGenerateValueChain } from './tools/generate-value-chain.mjs';
export { EVALUATE_MAP_TOOL, handleEvaluateMap } from './tools/evaluate-map.mjs';
export { IDENTIFY_CAPABILITY_TOOL, handleIdentifyCapability } from './tools/identify-capability.mjs';
export { ESTIMATE_ANCHOR_EVOLUTION_TOOL, handleEstimateAnchorEvolution } from './evolution/estimate-anchor-evolution.mjs';

// ─── Strategy Registry ──────────────────────────────────────────────────────
export { loadStrategies, getStrategy, listStrategies } from './strategies/registry.mjs';

// ─── Routing ────────────────────────────────────────────────────────────────
export { classifyComponent } from './routing/classification-gate.mjs';
export { detectMode, routeEstimateEvolution } from './routing/mode-router.mjs';

// ─── Shared Utilities ───────────────────────────────────────────────────────
export { createLLMCall, createStructuredLLMCall } from './lib/llm/llm-call.mjs';
export { detectLanguage } from './lib/language-detect.mjs';
export { formatResponse } from './lib/response-formatter.mjs';
