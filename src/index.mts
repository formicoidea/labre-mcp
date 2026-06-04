// labre-mcp — main entry point
//
// Re-exports the public API surface for programmatic consumers.
// For MCP server usage, run the HTTP daemon: `pnpm mcp` (dev) or
// `pnpm mcp:prod` (after `pnpm build`).

// ─── Shared Utilities ───────────────────────────────────────────────────────
export { createLLMCall, createStructuredLLMCall } from './lib/llm/llm-call.mjs';
export { detectLanguage } from './lib/language-detect.mjs';
export { formatResponse } from './lib/response-formatter.mjs';
