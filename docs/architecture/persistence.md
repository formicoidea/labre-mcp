# Persistence

> Cross-references: [ADR-12](decisions.md#arch-12--artefacts-persist-as-json-files-in-labre-mcpruns) (artefacts), [ADR-13](decisions.md#arch-13--primary-memory-is-the-conversation-transcript-not-memorymd) (memory model), [ADR-21](decisions.md#arch-21--three-categories-of-configuration) (config tiers).

## Memory model

labre-mcp keeps three substrates of memory:

| Substrate | Role | Duration | Form |
|---|---|---|---|
| **Conversation transcript** | Primary navigation, narrative, reasoning | Session → indefinite (via harness logs) | Text — managed by the LLM client (e.g. Claude Code's JSONL) |
| **JSON artefacts** | Cristallised per-run trace + final AST | As long as the file exists on disk | Files in `~/.labre-mcp/runs/<projectId>/<runId>.json` |
| **In-memory event bus** | Hot state during recipe execution | < 1 minute typical | RxJS Subject — per recipe execution |

labre-mcp **neither reads nor writes** the auto-memory system (`memory.md`). That substrate is scoped to user profile, feedback, and project meta-info — never tool artefacts.

## Why files, not Kafka or DuckDB

The trajectory deliberately excludes message brokers:

- V1: in-memory bus + JSON artefacts on local disk
- V2: same as V1 + optional DuckDB **read** layer over the artefacts (lazy, on-demand)
- V3 SaaS: per-tenant artefact storage; same JSON format

There is no V where Kafka becomes legitimate — artefact persistence is a per-process write pattern, not a multi-producer / multi-consumer streaming concern. See ADR-10 for the full reasoning.

## Artefact format

Each recipe execution produces one JSON file with this shape (see [`ArtifactBody`](../../src/core/persistence/artifact-writer.mts)):

```json
{
  "schemaVersion": "1.0",
  "recipeRunId": "uuid",
  "sessionId": "uuid",
  "domain": "wardley",
  "projectId": "abc123",
  "projectRoot": "/home/user/wardley-project",
  "startedAt": "2026-05-10T14:23:00Z",
  "completedAt": "2026-05-10T14:23:47Z",
  "events": [
    { "schemaVersion": "1.0", "recipeRunId": "...", "stepId": "...", "methodId": "...", "phase": "step-start|step-end|run-end", "timestamp": "...", "durationMs": "...", "payload": "..." }
  ],
  "ast": { ... }   // the final AST after all steps
}
```

The format is **deliberately verbose and LLM-readable**: descriptive keys, no abbreviation, no compression. The conversation can `cat` an artefact and reason about it directly. V2 analytics layers (DuckDB) consume the same files unchanged.

## File location

Default: `~/.labre-mcp/runs/<projectId>/<runId>.json`

- `~/` = the OS user's home (cross-platform via `node:os` `homedir()`)
- `<projectId>` = stable per project (see "Project identity" below)
- `<runId>` = a UUID generated at recipe start

Override via `context.artifactDir` for project-local benchmarks (e.g. checked into the repo at `<projectRoot>/.labre/benchmarks/`).

## Project identity

`projectId` is resolved by [`resolveProjectId`](../../src/core/persistence/project-id-resolver.mts):

1. If `<projectRoot>/.labre/project.json` exists and contains a valid `projectId` field, use it. This lets users assign stable IDs that survive across machines and cloned repos.
2. Otherwise, derive a 16-character SHA-1 hash of the absolute `projectRoot`. This is deterministic per machine but changes if the path moves.

Users can initialise an explicit project marker with [`initProjectMarker`](../../src/core/persistence/project-id-resolver.mts):

```ts
await initProjectMarker(projectRoot, crypto.randomUUID());
```

## Core listener: artifact-writer

[`attachArtifactWriter`](../../src/core/listeners/artifact-writer-listener.mts) is a core (non-disablable) listener that:

1. Subscribes to the event bus when a recipe starts.
2. Captures every event into an array.
3. On the `run-end` event, calls `writeArtifact` with the captured trace + final AST.

Failures during the write are swallowed silently — persistence must never abort a recipe (fail-open). The `artifactPath` promise resolves to `null` in that case.

## V2 analytics (deferred)

When cross-run analytics becomes a real driver, DuckDB embedded reads the artefacts directly without ingestion:

```sql
SELECT
  recipe,
  AVG(CAST(json_extract(result, '$.confidence') AS DOUBLE)) AS avg_confidence
FROM read_json_auto('~/.labre-mcp/runs/<projectId>/*.json')
WHERE startedAt > NOW() - INTERVAL 30 DAY
GROUP BY recipe;
```

No ingestion pipeline, no schema migration — the artefacts ARE the database. This is deferred to V1.5+; designing for it does not require any V1 changes since the artefact format is already analytical-ready.

## Privacy considerations

Artefacts capture tool inputs and outputs verbatim, including any context the caller provided. If sensitive information must not be persisted, the caller should:

- Pass `artifactDir: "/dev/null"` in dev (or equivalent platform-specific null path), or
- Pre-redact sensitive fields before invocation, or
- (V1.5+) opt out via a per-recipe `persistArtifact: false` flag.

Current V1: artefacts are always written. SaaS V3 will introduce a redaction policy + opt-out controls.
