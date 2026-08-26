// VENDORED CONTRACT — the AgentAdapter seam of labre's published language
// (`@labre/ai-api`, ADR-0020 / ADR-0026 Decision 2). This file is a COPY, not
// an authored contract: labre owns it, labre-mcp consumes it.
//
// WHY VENDORED AND NOT DEPENDED ON (ARCH-30, the one honest option of three).
// `@labre/ai-api` is `"private": true` and its single export is
// `"." : "./src/index.ts"` — source-first TypeScript, never published to a
// registry. So:
//
//   * an npm dependency is impossible (nothing to install);
//   * a `file:` / workspace link would tie labre-mcp — a package that IS
//     published, and whose lib mode must build with no sibling checkout — to
//     the presence of `../labre` on disk, breaking `pnpm build` for anyone else;
//   * a re-declaration from memory would be a second, silently drifting
//     contract, i.e. exactly the thing a published language exists to prevent.
//
// Vendoring is therefore the only shape left, and it is only defensible with a
// mechanical parity check. `agent-adapter.parity.test.mts` holds two guards:
// one that always bites (the vendored surface is pinned by name and by value)
// and one that bites harder when `../labre` is reachable (the upstream source
// is hashed and diffed field by field). Refreshing this file means re-running
// that test and updating UPSTREAM_SHA256 in the same commit.
//
// PROVENANCE
//   source:   labre/packages/ai-api/src/adapter.ts
//   commit:   14c6fe8 (labre, branch staging)
//   authored: 2026-07-19
//   sha256:   4d169620b32e0cf21cd47be11b677c8795d15ddb5f7acab2329bd1093a1fbefe
//             (of the file with CRLF normalised to LF — see the parity test)
//
// TWO DELIBERATE NARROWINGS, both recorded in ARCH-30 rather than hidden here:
//
//   1. `AiCommand` is carried as an OPAQUE envelope (`{ type }` + arbitrary
//      params) instead of importing the 750-line command catalogue. labre-mcp
//      is a CONDUIT for a proposal, never its executor: under ask mode
//      (ADR-0026 Decision 3, the external-agent default) a human's client
//      applies the command and that client is the validator. What labre-mcp
//      DOES enforce is the command's NAME, against the vendored allow-list in
//      `ai-command-names.mts` — enough to keep an unknown verb out of a
//      persisted message, without vendoring a catalogue that changes weekly.
//   2. `AgentSession` / `AgentTurnInput` / `AgentTurnResult` / `AgentEvent` are
//      reproduced VERBATIM. Nothing about the turn's shape is narrowed.

/** One of labre's `ai-command` proposals, carried opaquely. Upstream this is
 *  the discriminated union built from `commandSchemas`; here it is the envelope
 *  plus its verb — see narrowing (1) in the header. */
export interface AiCommand {
  type: string;
  params?: unknown;
}

/** The published error taxonomy, reused verbatim (upstream `aiErrorCodeSchema`
 *  in `schemas.ts`). No new enum — ADR-0026 Decision 2. */
export const aiErrorCodes = [
  'invalid-command',
  'not-implemented',
  'unavailable',
  'failed',
] as const;
export type AiErrorCode = (typeof aiErrorCodes)[number];

/** A conversation attachment (ADR-0026 Decision 2 `createSession` input). The
 *  caller resolves identity + authorization and hands the resolved values here:
 *  the ADR-0013 `sessionId` key, the read `scope`, and the `writeMode` floor
 *  (ADR-0021). The adapter conducts turns within this session; it does not
 *  re-resolve authorization. */
export interface AgentSession {
  conversationId: string;
  /** ADR-0013 join key, minted by the harness (one interaction burst). */
  sessionId: string;
  /** Resolved read tier (ADR-0021). */
  scope: 'full' | 'restricted';
  /** Resolved write floor (ADR-0021); 'ask' is the external-agent default. */
  writeMode: 'auto' | 'ask' | 'read-only';
}

/** Per-turn input. The prompt/context is a *handle*, not the transcript: the
 *  in-app loop reads the persisted thread server-side each round (no message is
 *  passed), so the only turn-scoped inputs it needs are the refusal notes fed
 *  into the first round's loop notes (ask mode, so the agent does not re-propose
 *  a declined command). An adapter that needs a literal prompt carries it here.
 *  Kept open (optional fields) so each adapter reads what it needs without a
 *  per-adapter fork of the contract. */
export interface AgentTurnInput {
  /** Short human descriptions of commands the user refused in earlier proposed
   *  turns — seeded into the first round so the agent does not repeat them. */
  refusedNotes?: readonly string[];
  /** A literal prompt, when an adapter's turn is prompt-driven rather than
   *  reading the persisted thread. The in-app adapter ignores it. */
  prompt?: string;
}

/** Token accounting for a turn. All fields optional: the in-app loop does not
 *  meter per-turn today (usage is left empty), while a metered adapter ([A3]
 *  quotas) fills it. `turn-end` always carries a `Usage` (possibly empty) so the
 *  ingestion point has one uniform shape to read. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** How a turn ended. `stop` = the agent stopped acting on its own (the normal
 *  end); `stopped` = the caller cancelled it (ADR-0026 Decision 5); `error` =
 *  the turn produced nothing and failed. */
export type AgentFinishReason = 'stop' | 'stopped' | 'error';

/** The result of one turn (ADR-0026 Decision 2 `sendTurn` return). */
export interface AgentTurnResult {
  turnId?: string;
  usage?: Usage;
  finishReason?: AgentFinishReason;
}

/** The normalized event vocabulary (ADR-0026 Decision 2). One agent-agnostic
 *  stream that the single ingestion point consumes and stamps ADR-0013 join
 *  keys on — the SAME code path for the in-app AI and any external agent.
 *
 *  Settlement (`applied`/`refused`) is DELIBERATELY NOT an event: under ask mode
 *  apply/refuse is a human gesture that happens after the turn, possibly much
 *  later, so the adapter cannot know it. The harness records settlement itself. */
export type AgentEvent =
  | { kind: 'message'; text: string }
  | { kind: 'tool-call-proposed'; command: AiCommand }
  | { kind: 'error'; code: AiErrorCode }
  | { kind: 'turn-end'; usage: Usage };

/** The kinds an {@link AgentEvent} can take — the closed set the ingestion point
 *  must handle exhaustively. */
export const agentEventKinds = [
  'message',
  'tool-call-proposed',
  'error',
  'turn-end',
] as const;
export type AgentEventKind = (typeof agentEventKinds)[number];

/** The contract (ADR-0026 Decision 2). A TypeScript interface — the adapter
 *  shape itself is structural. */
export interface AgentAdapter {
  /** Attach to a conversation. Identity + authorization are resolved by the
   *  caller and passed in; this performs no async authorization of its own. */
  createSession(input: {
    conversationId: string;
    sessionId: string;
    scope: 'full' | 'restricted';
    writeMode: 'auto' | 'ask' | 'read-only';
  }): Promise<AgentSession>;

  /** Conduct ONE turn (the whole multi-round loop for a loop-based agent).
   *  Normalized events are delivered through `onEvent` as they occur; the
   *  promise resolves when the turn ends, its result carrying usage. */
  sendTurn(
    session: AgentSession,
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentTurnResult>;

  /** Idempotent. A disconnect MUST leave no orphan turn (ADR-0026 Decision 5).
   *  `turnId` narrows the cancel to one turn when an adapter runs several; a
   *  single-flight adapter ignores it. */
  cancel(session: AgentSession, turnId?: string): Promise<void>;

  readonly capabilities: { streaming: boolean; interrupt: boolean };
}
