// labre-mcp — main entry point
//
// Re-exports the public API surface for programmatic consumers.
// For MCP server usage, run: npx tsx src/mcp/mcp-server.mts (dev)
// or: node dist/mcp/mcp-server.mjs (prod, after pnpm run build)

// ─── MCP Server ─────────────────────────────────────────────────────────────
export { startServer, REGISTERED_TOOLS, TOOL_HANDLERS, handleRequest } from './mcp/mcp-server.mjs';

// ─── Tools ──────────────────────────────────────────────────────────────────
export { ESTIMATE_EVOLUTION_TOOL, handleEstimateEvolution } from './mcp/estimate-evolution.tool.mjs';
export { EVALUATE_MAP_TOOL, handleEvaluateMap } from './mcp/evaluate-map.tool.mjs';
export { IDENTIFY_CAPABILITY_TOOL, handleIdentifyCapability } from './mcp/identify-capability.tool.mjs';
export { ESTIMATE_ANCHOR_EVOLUTION_TOOL, handleEstimateAnchorEvolution } from './mcp/estimate-anchor-evolution.tool.mjs';
export { GENERATE_VALUE_CHAIN_TOOL, handleGenerateValueChain } from './mcp/generate-value-chain.tool.mjs';

// ─── Strategy Registry ──────────────────────────────────────────────────────
export { loadStrategies, getStrategy, listStrategies } from '#work-on-evolution/write/strategies/capacity/registry.mjs';

// ─── Routing ────────────────────────────────────────────────────────────────
export { classifyComponent } from '#work-on-evolution/write/routing/classification-gate.mjs';
export { detectMode, routeEstimateEvolution } from '#work-on-evolution/write/routing/mode-router.mjs';

// ─── Shared Utilities ───────────────────────────────────────────────────────
export { createLLMCall, createStructuredLLMCall } from './lib/llm/llm-call.mjs';
export { detectLanguage } from './lib/language-detect.mjs';
export { formatResponse } from './lib/response-formatter.mjs';
