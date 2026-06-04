// fallow-ignore-file unused-export
// fallow-ignore-file unused-types
// This barrel is the documented public API of the degradation framework
// (mémoire feedback_mcp_degradable.md). Symbols are exposed even when
// internal callers reach the sub-modules directly — keep the surface
// stable so external consumers depend on a single entry point.
//
// Public surface of the degradation framework.
//
// Importers should reach for this barrel rather than the individual files,
// e.g. `import { withMcpDegradation, tryDegrade } from '../../lib/degradation/index.mjs';`.

export type {
  Degradable,
  DegradationEvent,
  DegradationSeverity,
  HealthCheck,
  HealthCheckOutcome,
} from './types.mjs';

export {
  registerHealthCheck,
  hasHealthCheck,
  listHealthChecks,
  clearRegistry,
  runHealthCheck,
  runAllHealthChecks,
} from './registry.mjs';

export { DegradationCollector } from './collector.mjs';
export { tryDegrade, tryDegradeAmbient } from './with-degradation.mjs';
export type { TryDegradeOptions } from './with-degradation.mjs';
export { withMcpDegradation } from './mcp-wrapper.mjs';
export type { McpHandler, WithMcpDegradationOptions } from './mcp-wrapper.mjs';
export { getCurrentCollector, runWithCollector, withCollector } from './context.mjs';
