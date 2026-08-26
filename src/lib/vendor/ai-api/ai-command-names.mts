// VENDORED — the NAMES of labre's `ai-command` verbs, extracted from the keys of
// `commandSchemas` in `labre/packages/ai-api/src/schemas.ts` (ADR-0020).
//
// Only the names, deliberately: see narrowing (1) in `agent-adapter.mts`. A
// proposal that labre-mcp relays under ask mode is applied by a human's client,
// which owns the parameter validation. What a conduit MUST still refuse is an
// unknown verb — a `{ type: "doc.deleteEverything" }` part persisted into a
// conversation is a lie about labre's surface whoever eventually reads it.
//
// PROVENANCE
//   source:  labre/packages/ai-api/src/schemas.ts — `commandSchemas` keys
//   commit:  14c6fe8 (labre, branch staging)
//   count:   36 (pinned by the parity test — a change here is a contract change)
//
// Query verbs (`querySchemas`, `clientQuerySchemas`) are NOT vendored: a query
// is something an agent asks labre to READ for it during a round, which this
// liaison does not do (ARCH-30, "where the line runs").

/** Every `ai-command` verb labre's client knows how to apply. */
export const AI_COMMAND_NAMES = [
  'nav.home',
  'nav.openDoc',
  'doc.create',
  'doc.rename',
  'doc.setMode',
  'doc.insertParagraph',
  'doc.appendMarkdown',
  'doc.insertMarkdown',
  'doc.replaceBlocks',
  'doc.deleteBlocks',
  'doc.embedDoc',
  'doc.embedCanvas',
  'doc.insertTable',
  'doc.createProperty',
  'doc.setProperty',
  'doc.deleteProperty',
  'collection.create',
  'collection.addDoc',
  'collection.removeDoc',
  'collection.rename',
  'collection.remove',
  'whiteboard.createWardleyNode',
  'whiteboard.createText',
  'whiteboard.createWardleyMap',
  'whiteboard.createShape',
  'whiteboard.createFrame',
  'whiteboard.createEdgyMap',
  'whiteboard.createEdgyNode',
  'whiteboard.createBpmnPool',
  'whiteboard.createBpmnNode',
  'whiteboard.createCynefin',
  'whiteboard.createEstuarine',
  'whiteboard.createCoreDomain',
  'whiteboard.connect',
  'whiteboard.connectChain',
  'whiteboard.insertTemplate',
] as const;

export type AiCommandName = (typeof AI_COMMAND_NAMES)[number];

const NAME_SET: ReadonlySet<string> = new Set<string>(AI_COMMAND_NAMES);

/** True when `name` is a verb labre's client can apply. */
export function isKnownCommandName(name: unknown): name is AiCommandName {
  return typeof name === 'string' && NAME_SET.has(name);
}
