// Report labre-mcp's LLM spend to labre's cost ledger (ADR-0032 Decision 3).
//
// labre-mcp is labre's subcontractor: when it runs as the labre-hosted HTTP
// daemon, every LLM call spends labre's own provider key, and that spend has to
// reach labre's one ledger (`public.ai_calls`) so the admin cost dashboard sees
// it AND labre's hourly token quota counts it (get_my_ai_usage sums the
// caller's ai_calls rows where agent_id is null — an MCP row is exactly that).
//
// ZERO daemon credentials, same posture as supabase-bundle-source.mts: the row
// is inserted under the CALLER's own JWT (via PostgREST + the public anon key),
// so ai_calls insert-own RLS authorises it and `user_id` defaults to the JWT's
// auth.uid(). No service-role key, no privileged path.
//
// Best-effort, exactly like reply.ts's ledger write: any failure is swallowed:
// metering must never fail a strategy run.
//
// WHY ONLY THE HOSTED DAEMON WRITES: a row can only be written when a caller
// JWT is present (currentLedgerJwt), which the HTTP transport sets and stdio
// never does. So a local/stdio run on the user's own keys writes nothing — it
// costs labre nothing and needs no reporting — and the "who funded it" question
// answers itself: the only writer is the labre-operated daemon on labre's key.
// KNOWN GAP: lab_ API-key callers are not JWTs (auth.uid() would be null), so
// their runs are skipped — the same limitation the bundle refresh has.

import type { LlmUsageRecord } from './usage-context.mjs';
import { currentLedgerJwt } from './ledger-auth-context.mjs';

// A lab_ personal API key is not a JWT: PostgREST could not resolve auth.uid()
// from it, so the insert would violate ai_calls.user_id NOT NULL. Skip it — the
// same rule the bundle refresh applies (labre-daemon.mts).
const API_KEY_PREFIX = 'lab_';

/** Report one run's LLM calls to the ledger, one `ai_calls` row per call.
 *  No-op (returns immediately) when there is no caller JWT, no Supabase config,
 *  or nothing to report — i.e. every path except the authenticated hosted
 *  daemon. Never throws. */
export async function reportUsageToLedger(records: LlmUsageRecord[]): Promise<void> {
  if (records.length === 0) return;

  const jwt = currentLedgerJwt();
  if (!jwt || jwt.startsWith(API_KEY_PREFIX)) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return;

  // One row per call. `user_id` is omitted on purpose — the column defaults to
  // auth.uid(), so the DB stamps the caller from the JWT and RLS stays honest.
  // `source: 'mcp'` marks the origin for the admin dashboard; agent_id is left
  // null (this is not a registered-agent turn), which is exactly what makes the
  // row count toward the caller's hourly token quota. `model` is NOT NULL, so a
  // record that carried no model (it always should, but be defensive) falls
  // back to its provider name.
  const rows = records.map((r) => ({
    model: r.model ?? r.provider,
    input_tokens: r.inputTokens ?? 0,
    output_tokens: r.outputTokens ?? 0,
    source: 'mcp',
  }));

  try {
    await fetch(`${supabaseUrl}/rest/v1/ai_calls`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        // Fire-and-forget: we don't need the inserted rows back.
        prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
  } catch {
    // Best-effort: a metering write never fails the run it measured.
  }
}
