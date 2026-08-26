// AiCallEmitted sentinel — count every LLM call the registry hands out.
//
// WHY: labre's invariant "every model spend leaves a ledger line" was enforced
// on one path only. `reportUsageToLedger` (ledger-report.mts) wrote an
// `ai_calls` row only when a caller JWT was present, which the HTTP transport
// sets and stdio never does; `lab_` API-key callers were skipped too, and the
// quota guard had the same blind spot. So an unknown share of the spend left no
// ledger line at all.
//
// HALF OF THAT IS NOW CLOSED (2026-08-26). `lab_`-keyed calls are ledgered and
// budgeted through `labre_mcp.record_mcp_key_spend`, so the gap this sentinel
// still measures should have shrunk to the population that has NO labre
// identity at all: stdio and lib mode, which spend the user's own keys and cost
// labre nothing. A residual gap on the HTTP daemon is now a real defect, not a
// known limitation — which is exactly what makes the measurement worth keeping.
//
// This module does NOT close that hole — it MEASURES it. Every call obtained
// through the registry emits one `AiCallEmitted` telemetry event per
// invocation. labre's admin counts those events against the `ai_calls` rows
// over the same window: the difference IS the size of the hole. The event name
// and the `source: 'mcp'` property are the contract with that counter — do not
// rename either without changing the admin side.
//
// PRIVACY: metadata only — strategy id, provider id, model, capability. Never a
// prompt, never a response, never a key. Same rule as the recipe telemetry
// forwarder (core/listeners/posthog-telemetry-listener.mts).
//
// Plumbing: reuses the daemon's PostHog instance through the existing
// #lib/flags/state.mjs singleton — no second transport. Consequence, stated
// rather than hidden: when no PostHog is installed (stdio transport, local
// daemon with no POSTHOG_API_KEY) the sentinel is silently inert. Making
// telemetry reach stdio is a separate piece of work.

import { getPostHogFlags } from '#lib/flags/state.mjs';
import type { LLMCapability } from './providers/provider.types.mjs';

/** Event name shared with labre's admin "emitted vs ledgered" counter. */
export const AI_CALL_EMITTED_EVENT = 'AiCallEmitted';

/**
 * Fixed distinct_id for the sentinel. This is an INFRASTRUCTURE counter, not
 * user analytics: the registry sits below the transport and has no request
 * context (ARCH-15 forbids reaching for ambient env/cwd at runtime), so there
 * is no user to attribute to. A constant id keeps the events groupable without
 * inventing an identity.
 */
export const AI_CALL_SENTINEL_DISTINCT_ID = 'ai-call-sentinel';

/** Metadata describing one resolved LLM call. Primitives only (see PRIVACY). */
export interface AiCallMeta {
  /** Strategy id the call was resolved for (registry lookup key). */
  strategy: string;
  /** Resolved provider id, as declared in llm.config.json. */
  provider: string;
  /** Resolved model name. */
  model: string;
  /** Capability the call site asked for. */
  capability: LLMCapability;
}

/**
 * Emit one `AiCallEmitted` event. Fire-and-forget, zero added latency, never
 * throws: `capture` is already non-blocking, and the try/catch covers a broken
 * or half-initialised client. A failed emission is silent — the sentinel then
 * UNDER-counts, which is accepted: it is a measuring instrument, not a control.
 */
export function emitAiCallEmitted(meta: AiCallMeta): void {
  try {
    const flags = getPostHogFlags();
    if (!flags) return; // no PostHog installed (stdio, local daemon) → inert
    flags.capture(AI_CALL_EMITTED_EVENT, AI_CALL_SENTINEL_DISTINCT_ID, {
      source: 'mcp',
      strategy: meta.strategy,
      provider: meta.provider,
      model: meta.model,
      capability: meta.capability,
    });
  } catch {
    // Telemetry must never disturb the call it observes.
  }
}

/** Shape every LLM call primitive satisfies (text / structured / logprobs /
 *  vision all being `(prompt, variables?, opts?) => Promise<...>`). `never[]`
 *  is the bottom parameter list, so any concrete call signature widens to it. */
type AnyLLMCall = (...args: never[]) => unknown;

/**
 * Wrap an LLM call so each INVOCATION emits the sentinel event. The wrapper is
 * transparent: same arguments, same return value, same rejections.
 *
 * The event is emitted BEFORE delegating, on purpose: a call that throws
 * mid-flight has usually already spent tokens, and under-counting spend is the
 * failure mode this sentinel exists to detect. The reverse bias — counting a
 * call that failed before reaching the provider — is the cheaper error.
 *
 * Calls are cached by the registry, so wrapping happens once per
 * (strategy, capability) pair while the event fires on every use.
 */
export function withAiCallSentinel<T extends AnyLLMCall>(call: T, meta: AiCallMeta): T {
  const wrapped = (...args: Parameters<T>): ReturnType<T> => {
    emitAiCallEmitted(meta);
    return call(...(args as never[])) as ReturnType<T>;
  };
  return wrapped as T;
}
