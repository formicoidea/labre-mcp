// DegradationCollector — captures degradation events for a single
// MCP tool invocation and emits MCP log notifications as side effects.
//
// Tools receive a collector via `withMcpDegradation` (mcp-wrapper.mts)
// and pass it down through their pipeline so that any external call can
// record fallback events without throwing.

import type {
  Degradable,
  DegradationEvent,
  DegradationSeverity,
} from './types.mjs';
import {
  logInfo,
  logWarning,
  logError,
} from '../mcp-notifications.mjs';
import { toErrorMessage } from '../errors.mjs';

type RecordInput = Omit<DegradationEvent, 'at'> & { at?: string };

export class DegradationCollector {
  private readonly events: DegradationEvent[] = [];
  private readonly logger: string;
  private degradedFlag = false;

  /**
   * @param logger Logger name passed to mcp-notifications (typically the tool name).
   */
  constructor(logger: string) {
    this.logger = logger;
  }

  /**
   * Record a degradation event. Emits an MCP log notification at the
   * matching severity (info/warning/error). Sets `degraded: true` for any
   * severity above `info`.
   */
  record(event: RecordInput): void {
    const fullEvent: DegradationEvent = {
      ...event,
      at: event.at ?? new Date().toISOString(),
    };
    this.events.push(fullEvent);
    if (fullEvent.severity !== 'info') this.degradedFlag = true;
    this.emitLog(fullEvent.severity, `[${fullEvent.source}] ${fullEvent.reason}`);
  }

  /**
   * Convenience: record an error caught in a try/catch as a degradation event.
   *
   * Defaults to `severity: 'warning'` and `recoverable: true` because the
   * caller already handled the failure with a fallback. Pass `recoverable:
   * false` when the dependency is required and the fallback is a stub.
   */
  recordError(
    source: string,
    err: unknown,
    opts: { recoverable?: boolean; severity?: DegradationSeverity } = {},
  ): void {
    const message = toErrorMessage(err) || 'unknown error';
    this.record({
      source,
      reason: message,
      severity: opts.severity ?? 'warning',
      recoverable: opts.recoverable ?? true,
      detail: { error: message },
    });
  }

  /**
   * Merge events from another collector into this one (e.g. a per-component
   * sub-collector merged into the batch collector for `evaluateMap`).
   *
   * Does NOT re-emit log notifications — the source collector already did.
   */
  merge(other: DegradationCollector): void {
    for (const evt of other.events) {
      this.events.push(evt);
      if (evt.severity !== 'info') this.degradedFlag = true;
    }
  }

  /** Read-only snapshot of recorded events in capture order. */
  getEvents(): DegradationEvent[] {
    return [...this.events];
  }

  /** True if at least one warning- or error-level event was recorded. */
  hasDegraded(): boolean {
    return this.degradedFlag;
  }

  /**
   * Wrap a tool result in the standard `Degradable<T>` envelope.
   * Always safe to call even when no events were recorded — yields
   * `{ result, degraded: false, degradationEvents: [] }`.
   */
  wrap<T>(result: T): Degradable<T> {
    return {
      result,
      degraded: this.degradedFlag,
      degradationEvents: this.getEvents(),
    };
  }

  private emitLog(severity: DegradationSeverity, message: string): void {
    if (severity === 'error') logError(this.logger, message);
    else if (severity === 'warning') logWarning(this.logger, message);
    else logInfo(this.logger, message);
  }
}
