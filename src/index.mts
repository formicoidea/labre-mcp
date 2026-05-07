// WardleyAssistant â€” main entry point
//
// Re-exports the public API surface for programmatic consumers.
// For MCP server usage, run: npx tsx src/mcp/mcp-server.mts (dev)
// or: node dist/mcp/mcp-server.mjs (prod, after pnpm run build)

// â”€â”€â”€ MCP Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export { startServer, REGISTERED_TOOLS, TOOL_HANDLERS, handleRequest } from './mcp/mcp-server.mjs';

// â”€â”€â”€ Tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export { ESTIMATE_EVOLUTION_TOOL, handleEstimateEvolution } from './mcp/estimate-evolution.tool.mjs';
export { EVALUATE_MAP_TOOL, handleEvaluateMap } from './mcp/evaluate-map.tool.mjs';
export { IDENTIFY_CAPABILITY_TOOL, handleIdentifyCapability } from './mcp/identify-capability.tool.mjs';
export { ESTIMATE_ANCHOR_EVOLUTION_TOOL, handleEstimateAnchorEvolution } from './mcp/estimate-anchor-evolution.tool.mjs';
export { GENERATE_VALUE_CHAIN_TOOL, handleGenerateValueChain } from './mcp/generate-value-chain.tool.mjs';

// â”€â”€â”€ Strategy Registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export { loadStrategies, getStrategy, listStrategies } from './work-on-evolution/write/strategies/capacity/registry.mjs';

// â”€â”€â”€ Routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export { classifyComponent } from './work-on-evolution/write/routing/classification-gate.mjs';
export { detectMode, routeEstimateEvolution } from './work-on-evolution/write/routing/mode-router.mjs';

// â”€â”€â”€ Shared Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export { createLLMCall, createStructuredLLMCall } from './lib/llm/llm-call.mjs';
export { detectLanguage } from './lib/language-detect.mjs';
export { formatResponse } from './lib/response-formatter.mjs';
