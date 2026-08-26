// The MCP liaison's AgentAdapter implementation (ARCH-30; ADR-0026 [A2]).
//
// THE BRAIN IS THE CALLER. Every other adapter of this contract owns a model:
// labre's in-app adapter drives `reply.ts`, which calls the gateway; a personal
// LLM's turn is conducted by `reply.ts` with the owner's provider config
// (ADR-0028 amendment, Decision A). This one owns NO model and calls NO
// provider — the agent sitting at the other end of the MCP connection has
// already thought, and hands its turn in as the tool's arguments.
//
// That is not a degenerate adapter, it is the point of the contract: ADR-0026
// Decision 2 says the vocabulary is normalized so that "nothing downstream
// knows which agent produced the events". An adapter whose `sendTurn` replays a
// caller-supplied payload into that same vocabulary makes the MCP caller a
// first-class participant with zero new ingestion path — and it is precisely
// what the contract's own `AgentTurnInput.prompt` field was left open for
// ("an adapter whose turn is prompt-driven rather than reading the persisted
// thread carries it here").
//
// WHAT THIS BUYS, concretely: labre-mcp holds no LLM credential on this path,
// spends nothing, and cannot leak a provider secret it never reads. The
// `get_agent_provider_config` door (ADR-0028 Decision 3c) is not opened here
// and must not be — see ARCH-30, "no privileged credential".
//
// CAPABILITIES are both false and will stay false while the turn arrives whole:
// there is nothing to stream (the payload is complete on arrival) and nothing to
// interrupt (no call is in flight). `cancel` is therefore a genuine idempotent
// no-op rather than a stub — ADR-0026 Decision 5's "a disconnect MUST leave no
// orphan turn" is honoured by the CLAIM's TTL and the orchestrator's release,
// not by this object.

import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentTurnInput,
  AgentTurnResult,
  AiCommand,
  Usage,
} from '#lib/vendor/ai-api/agent-adapter.mjs';

/** One turn as the MCP caller hands it in — the whole of what its brain
 *  produced, already finished. Mirrors the shape labre's own ingestion point
 *  composes from (`AgentTurnOutput` in apps/web/src/modules/agent-ingestion.ts):
 *  a reasoning trace, the final prose, proposals, a truncation marker. */
export interface CallerTurn {
  /** The final prose — the message bubble. */
  text: string;
  /** Per-round reasoning, persisted as the collapsible `ai-reasoning` trace. */
  reasoning?: readonly string[];
  /** Commands the agent PROPOSES. Under ask mode (the external-agent default)
   *  they are persisted `pending`; a human's client applies them. */
  commands?: readonly AiCommand[];
  /** The caller's own answer was cut off at its model's output limit. */
  truncated?: boolean;
  /** Token accounting, caller-asserted (see ARCH-30's honesty note). */
  usage?: Usage;
}

/**
 * An {@link AgentAdapter} whose turn is supplied, not computed.
 *
 * `sendTurn` replays the caller's turn into the normalized vocabulary in the
 * order the ingestion point composes it: the prose first (`message`), then each
 * proposal (`tool-call-proposed`), then `turn-end` carrying usage. The order is
 * part of the contract's usefulness — it is what lets one ingestion routine
 * serve every adapter — so it is asserted in the tests, not left to chance.
 */
export class CallerSuppliedAdapter implements AgentAdapter {
  readonly capabilities = { streaming: false, interrupt: false } as const;

  constructor(private readonly turn: CallerTurn) {}

  async createSession(input: {
    conversationId: string;
    sessionId: string;
    scope: 'full' | 'restricted';
    writeMode: 'auto' | 'ask' | 'read-only';
  }): Promise<AgentSession> {
    // No authorization is re-resolved here, by contract: the caller resolved it
    // (ADR-0026 Decision 2). For this liaison "the caller" is the orchestrator,
    // which pins scope/writeMode to the ADR-0021 guest floor before calling.
    return { ...input };
  }

  async sendTurn(
    _session: AgentSession,
    _input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentTurnResult> {
    const text = this.turn.text.trim();
    if (text.length > 0) onEvent({ kind: 'message', text });
    for (const command of this.turn.commands ?? []) {
      onEvent({ kind: 'tool-call-proposed', command });
    }
    const usage = this.turn.usage ?? {};
    onEvent({ kind: 'turn-end', usage });
    return { usage, finishReason: 'stop' };
  }

  async cancel(): Promise<void> {
    // Idempotent by contract. Nothing is in flight on this adapter — see header.
  }
}
