# Position — MCP-owned data store & CDC

**Status: decided (July 2026) — build nothing now.** This document records why,
and the explicit triggers that would reopen the question.

## Current state (verified against the codebase)

The MCP is **deliberately stateless**:

- It owns **no database** and holds **no DB credentials** (never the Supabase
  service-role key). Its only durable writes are local files:
  `~/.labre-mcp/runs/` (run artifacts), `~/.labre-mcp/cache/` (BigQuery CPC
  cache), `<projectRoot>/.labre/project.json` (project id marker).
- Its only touchpoint with the labre application's database is **read-only,
  RLS-gated, authenticated as the calling end-user**: the `strategy_bundles`
  table + `strategy-bundles` storage bucket, consumed through
  `src/lib/bundles/supabase-bundle-source.mts` with the caller's JWT and the
  public anon key. No MCP-owned data lives in the labre database.
- The bundle refresh is already a **poll-based read-model sync**: a TTL probe
  (`max(updated_at)` + count, default 300 s) triggers a reload of changed rows,
  every file re-verified against its sha256 seal.

## Why no dedicated database now

- **PostHog is the experiment store.** Prompt A/B testing (see
  [remote-admin-contracts](../technical/remote-admin-contracts.md), contract 4)
  attributes outcomes per variant natively via `$feature/` properties on
  `mcp_run_end` / `mcp_step_error`, with latency, success/failure, token usage
  and numeric quality metrics as event properties. Retention, cohorting and
  significance analysis are PostHog features; a dedicated experiments DB would
  duplicate them and add nothing.
- **A write DB breaks the zero-credential invariant.** The whole bundle-source
  security model rests on the daemon holding no privileged credentials and
  being able to crash-and-reload from remote state. Giving it a database of
  its own reintroduces exactly the credential + migration surface the
  remote-admin design removed.
- **CDC (Debezium-style) has nothing to capture.** CDC streams row changes out
  of an OLTP database the consumer owns; the MCP has none, and the single
  labre table it reads is a slow-moving config table for which the TTL probe
  is the cheapest correct sync.

## Triggers that reopen the question

1. **Cross-domain analytics**: A/B outcomes must be join-queried against labre
   business rows (revenue, retention) beyond what PostHog export supports →
   a dedicated **analytics** DB fed by PostHog exports. Still not Debezium.
2. **Genuine MCP-owned mutable state** outliving a request (server-side
   assignment stickiness PostHog cannot provide, cross-session run history
   replacing the local JSON artifacts — the anticipated "V2 DuckDB" layer) →
   a dedicated MCP DB. CDC only if that DB then becomes a real-time source
   other systems must react to.
3. **Freshness SLA**: the 300 s TTL probe can no longer meet bundle-freshness
   requirements at fleet scale → replace polling with Supabase
   Realtime/logical-replication push. Debezium is the last resort, not the
   first.

Until one of these fires: PostHog for experiment data, TTL polling for the
bundle read model, local files for run artifacts.
