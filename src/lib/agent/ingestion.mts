// The liaison's ingestion point (ARCH-30; ADR-0026 Decision 2, last paragraph).
//
// ONE agent-agnostic routine that consumes a turn's normalized `AgentEvent`
// stream and composes the assistant message labre persists — the ADR-0015 parts
// vocabulary, in the ADR-0015 order. It is the transposition of labre's own
// `composeAssistantMessage` (apps/web/src/modules/agent-ingestion.ts), which the
// [A1] slice extracted for exactly this reuse and whose header says so: "the
// same composition serves 'external-agent' by switching this parameter only".
//
// WHY TRANSPOSED RATHER THAN CALLED. That module is a browser module: it imports
// the Supabase browser client, the message repository and the command-extraction
// helpers of `apps/web`. What is REUSED is the composition rule, which is why
// the dedupe below (`while`, not `if`) and the part ORDER are copied deliberately
// rather than reinvented — a divergence here shows up as a doubled sentence or a
// misplaced truncation marker in a real thread. The ADR-0015 part order is the
// contract; the tests pin it.
//
// PURE. No I/O, no clock, no ids minted: it turns events into a payload. The
// orchestrator does the RPC. That split is what lets the composition be tested
// without a database.

import { isKnownCommandName } from '#lib/vendor/ai-api/ai-command-names.mjs';
import type { AgentEvent, AiErrorCode, Usage } from '#lib/vendor/ai-api/agent-adapter.mjs';

/** One part of a labre message's `content` array (ADR-0015). Structural, not
 *  exhaustive: this liaison emits four of the kinds labre renders. */
export type MessagePart =
  | { type: 'ai-reasoning'; steps: string[] }
  | { type: 'text'; text: string }
  | { type: 'ai-truncated' }
  | { type: 'ai-command'; command: { type: string; params?: unknown }; status: 'pending' }
  | { type: 'doc-embed'; doc_id: string };

/** What the ingestion accumulated over one turn. */
export interface IngestedTurn {
  /** The composed `content` array, ready for `insert_agent_message`. Empty when
   *  the turn produced nothing worth persisting. */
  content: MessagePart[];
  /** Usage as reported by `turn-end` — fuel for the ledger row. */
  usage: Usage;
  /** Error codes the turn emitted. NEVER persisted (labre treats reply errors as
   *  ephemeral, on the triggering client) — surfaced in the tool result instead. */
  errors: AiErrorCode[];
  /** Proposals dropped because their verb is not in labre's allow-list. Reported
   *  back to the caller so a mistyped command is a visible refusal, not silence. */
  rejectedCommands: string[];
}

/** Extra join keys the caller supplies (ADR-0013). `docId` seeds both the
 *  `doc_id` key and the trailing `doc-embed` view, exactly as labre does. */
export interface IngestionOptions {
  /** Per-round reasoning prose, if the caller chose to expose its trace. */
  reasoning?: readonly string[];
  /** The turn was cut off at the caller's model output limit. */
  truncated?: boolean;
  /** The map/document this turn worked in. */
  docId?: string | null;
}

/**
 * Fold a turn's normalized events into the assistant message payload.
 *
 * Order (ADR-0015, copied from labre's composer): reasoning trace → prose →
 * truncation marker → proposals → doc-embed. The marker sits BEFORE the
 * proposals so the "incomplete" flag reads with the prose it qualifies.
 */
export function ingestTurnEvents(
  events: readonly AgentEvent[],
  options: IngestionOptions = {},
): IngestedTurn {
  let text = '';
  let usage: Usage = {};
  const errors: AiErrorCode[] = [];
  const rejectedCommands: string[] = [];
  const ops: MessagePart[] = [];

  for (const event of events) {
    switch (event.kind) {
      case 'message':
        // Delta-accumulated upstream; this adapter emits one whole message per
        // turn, and a second one would mean the last word wins — which is what
        // "the final prose is the last round's text" means in labre's composer.
        text = event.text;
        break;
      case 'tool-call-proposed': {
        const name = event.command.type;
        if (!isKnownCommandName(name)) {
          // A conduit refuses what labre's client could not apply. Dropping it
          // LOUDLY (reported in the result) beats persisting a part that renders
          // as a dead button in someone's thread.
          rejectedCommands.push(String(name));
          break;
        }
        // Ask mode is the external-agent default (ADR-0026 Decision 3), and this
        // liaison never leaves it: every proposal lands `pending`, settled later
        // by a human's client. `status` is a literal here, never a parameter —
        // the same discipline as the actor being hard-coded in the RPC.
        ops.push({ type: 'ai-command', command: event.command, status: 'pending' });
        break;
      }
      case 'error':
        errors.push(event.code);
        break;
      case 'turn-end':
        usage = event.usage;
        break;
    }
  }

  // Don't repeat the final prose as a reasoning step. A WHILE, not an `if`: a
  // turn can end on a run of rounds carrying the same sentence, and one pop
  // would leave the rest rendering as both trace and bubble (labre's composer
  // carries this note; the bug it describes is real).
  const steps = [...(options.reasoning ?? [])];
  while (steps.length > 0 && steps.at(-1) === text) steps.pop();

  const docId = options.docId ?? null;
  const content: MessagePart[] = [];
  if (steps.length > 0) content.push({ type: 'ai-reasoning', steps });
  if (text) content.push({ type: 'text', text });
  if (options.truncated) content.push({ type: 'ai-truncated' });
  content.push(...ops);
  if (docId) content.push({ type: 'doc-embed', doc_id: docId });

  return { content, usage, errors, rejectedCommands };
}
