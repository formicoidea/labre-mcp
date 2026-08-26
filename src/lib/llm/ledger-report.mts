// Report labre-mcp's LLM spend to labre's cost ledger (ADR-0032 Decision 3).
//
// labre-mcp is labre's subcontractor: when it runs as the labre-hosted HTTP
// daemon, every LLM call spends labre's own provider key, and that spend has to
// reach labre's one ledger (`public.ai_calls`) so the admin cost dashboard sees
// it AND labre's hourly token quota counts it (get_my_ai_usage sums the
// caller's ai_calls rows where agent_id is null — an MCP row is exactly that).
//
// ZERO daemon credentials, same posture as supabase-bundle-source.mts: no
// service-role key, no privileged path. There are TWO writes, one per identity
// the daemon can actually see at its door:
//
//   * JWT caller — the row is inserted under the CALLER's own JWT (PostgREST +
//     the public anon key), so `ai_calls` insert-own RLS authorises it and
//     `user_id` defaults to the JWT's auth.uid().
//   * `lab_` API key — NOT a JWT: auth.uid() would be null and the insert would
//     violate `user_id NOT NULL`. Those runs used to be SKIPPED outright; this
//     was the KNOWN GAP, and labre's CH-03 sentinel measured it. They now go
//     through `labre_mcp.record_mcp_key_spend`, a SECURITY DEFINER RPC granted
//     to `anon` — the same door and the same access model as
//     `validate_api_key`, which the auth middleware already calls with the anon
//     key. The RPC resolves the key to `labre_mcp.api_keys.user_id`, applies the
//     owner's hourly budget, and inserts the row attributed to that owner. The
//     daemon still holds no privileged credential; the KEY is the credential,
//     and it travels memory → RPC and is never logged.
//
// Closing that gap is not a nicety: labre-mcp is a dead end that writes no
// labre business state, but it IS metered by labre (ARCH-31) — the tokens a
// client burns here are tokens that client pays for.
//
// Best-effort, exactly like reply.ts's ledger write: any failure is swallowed —
// metering must never fail a strategy run.
//
// WHAT STILL WRITES NOTHING: a run with no caller identity at all. `stdio` never
// sets one (it has no auth middleware and reads no key from the environment —
// see labre-stdio.mts), and neither do lib mode or the unit tests. A local
// stdio run spends the user's OWN provider keys, costs labre nothing and has no
// labre account to bill; "stdio local sans clé = non compté" is assumed, not
// overlooked. Give stdio a `lab_` identity one day and this same path meters it
// with no change here.

import type { LlmUsageRecord } from './usage-context.mjs';
import { currentLedgerJwt } from './ledger-auth-context.mjs';
import { noteKeyBudgetDenied, forgetKeyBudgetDenial } from './quota-guard.mjs';

/** A `lab_` personal API key is not a JWT — it takes the definer-RPC path. */
const API_KEY_PREFIX = 'lab_';

/** One `ai_calls` row's worth of numbers, in the shape both paths send. */
interface LedgerRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/** `model` is NOT NULL in the ledger, so a record that carried none (it always
 *  should, but be defensive) falls back to its provider name. */
function toRow(record: LlmUsageRecord): LedgerRow {
  return {
    model: record.model ?? record.provider,
    input_tokens: record.inputTokens ?? 0,
    output_tokens: record.outputTokens ?? 0,
  };
}

/** The statuses `labre_mcp.record_mcp_key_spend` answers with. `unreachable` is
 *  ours, not the RPC's: it names a failed round-trip, which degrades open. */
export type KeySpendStatus = 'recorded' | 'denied' | 'invalid-key' | 'unreachable';

/** One row's answer from the key-side RPC. Never carries the key back. */
export interface KeySpendOutcome {
  status: KeySpendStatus;
  used: number;
  limit: number;
}

function toNum(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** Record ONE row against a `lab_` key. Never throws; a broken round-trip
 *  answers `unreachable` so the caller degrades open rather than guessing. */
async function recordKeySpend(
  apiKey: string,
  row: LedgerRow,
  supabaseUrl: string,
  anonKey: string,
): Promise<KeySpendOutcome> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/record_mcp_key_spend`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        'content-type': 'application/json',
        // The RPC lives in the labre_mcp schema, not public — same header the
        // validate_api_key call already sends.
        'content-profile': 'labre_mcp',
      },
      body: JSON.stringify({
        p_key: apiKey,
        p_model: row.model,
        p_input_tokens: row.input_tokens,
        p_output_tokens: row.output_tokens,
      }),
    });
    if (!res.ok) return { status: 'unreachable', used: 0, limit: 0 };
    const body: unknown = await res.json();
    // Untrusted input — narrowed field by field, like the api-key validator.
    const first = Array.isArray(body) ? body[0] : body;
    if (!first || typeof first !== 'object') {
      return { status: 'unreachable', used: 0, limit: 0 };
    }
    const record = first as Record<string, unknown>;
    const status = record.status;
    if (status !== 'recorded' && status !== 'denied' && status !== 'invalid-key') {
      return { status: 'unreachable', used: 0, limit: 0 };
    }
    return {
      status,
      used: toNum(record.tokens_used),
      limit: toNum(record.tokens_limit),
    };
  } catch {
    // The error object could quote the request; nothing from it is surfaced,
    // and the key appears in no message on any path.
    return { status: 'unreachable', used: 0, limit: 0 };
  }
}

/** Report one run's LLM calls for a `lab_`-keyed caller, one RPC per call.
 *
 *  A `denied` STOPS the loop and is memoised on the key (quota-guard), so the
 *  caller's NEXT run is refused BEFORE it spends, and refused as a status the
 *  tool result carries rather than as an opaque failure. That is the same
 *  timing the JWT path has always had — `get_my_ai_usage` reads spend already
 *  written, so the run that crosses the line always completes and the one after
 *  it is stopped. The key path is now its twin, not a weaker cousin. */
async function reportKeyUsage(
  apiKey: string,
  rows: LedgerRow[],
  supabaseUrl: string,
  anonKey: string,
): Promise<void> {
  for (const row of rows) {
    const outcome = await recordKeySpend(apiKey, row, supabaseUrl, anonKey);
    if (outcome.status === 'denied') {
      noteKeyBudgetDenied(apiKey, outcome.used, outcome.limit);
      // The remaining rows would be denied by the same budget: stop asking.
      return;
    }
    if (outcome.status === 'recorded') {
      // The budget answered yes: any stale memo of a past refusal is wrong now.
      forgetKeyBudgetDenial(apiKey);
    }
    // 'invalid-key' and 'unreachable' are swallowed — a metering write never
    // fails the run it measured, and an invalid key already lost at the door.
  }
}

/** Report one run's LLM calls to the ledger, one `ai_calls` row per call.
 *  No-op (returns immediately) when there is no caller identity, no Supabase
 *  config, or nothing to report — i.e. stdio, lib mode and tests. Never throws. */
export async function reportUsageToLedger(records: LlmUsageRecord[]): Promise<void> {
  if (records.length === 0) return;

  const bearer = currentLedgerJwt();
  if (!bearer) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return;

  const rows = records.map(toRow);

  if (bearer.startsWith(API_KEY_PREFIX)) {
    await reportKeyUsage(bearer, rows, supabaseUrl, anonKey);
    return;
  }

  // JWT path, unchanged: one batched insert. `user_id` is omitted on purpose —
  // the column defaults to auth.uid(), so the DB stamps the caller from the JWT
  // and RLS stays honest. `source: 'mcp'` marks the origin for the admin
  // dashboard; agent_id is left null (this is not a registered-agent turn),
  // which is exactly what makes the row count toward the caller's hourly quota.
  try {
    await fetch(`${supabaseUrl}/rest/v1/ai_calls`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        // Fire-and-forget: we don't need the inserted rows back.
        prefer: 'return=minimal',
      },
      body: JSON.stringify(rows.map((row) => ({ ...row, source: 'mcp' }))),
    });
  } catch {
    // Best-effort: a metering write never fails the run it measured.
  }
}
