// Supabase-backed remote source for strategy bundles (read model, phase 3).
//
// Zero daemon credentials: the daemon holds NO Supabase key of its own (and
// never the service-role key). Bundles are fetched lazily with the CALLER's
// JWT — on an authenticated request the raw bearer token (plus the public
// anon key) authenticates a short-lived Supabase client; RLS on
// `strategy_bundles` / the `strategy-bundles` bucket does the authorization.
//
// Security invariants:
//   - the bearer token is a call parameter only: never stored on the source,
//     never logged, never kept beyond the refresh it authenticates;
//   - the Supabase client is created per-refresh with the token in headers
//     and discarded when the refresh settles;
//   - Supabase content is untrusted input: rows are zod-validated, every
//     downloaded file is sha256-re-verified against the row's `files` seal
//     (written by the admin API via service-role), and the bundle itself goes
//     through the same `loadBundleFromFiles` static validation as local ones.
//
// Statelessness: everything happens in memory (no temp files); a crashed or
// scaled instance simply reloads on its next authenticated request.
//
// Bundle prompts are now LIVE: each accepted bundle registers its prompt
// overrides alongside its recipe (registerBundleRecipe's third argument), so a
// run of that recipe layers the bundle's prompts over the shipped ones via the
// run-scoped override store. Overridability is enforced per bundle here (each
// override must shadow a shipped template prompt) — a bundle failing that check
// is rejected like any other bad bundle, and the rest still load.
//
// @supabase/supabase-js is loaded via dynamic import() inside the default
// client factory only — the stdio transport and unauthenticated daemons
// never load it.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateOrThrow } from '#lib/zod/validate-or-throw.mjs';
import {
  registerBundleRecipe,
  resetBundleRecipes,
} from '#core/recipe/recipe-loader.mjs';
import type { Recipe } from '#core/recipe/recipe.schema.mjs';
import type { BundlePromptPair } from '#lib/prompts/override-context.mjs';
import { assertBundlePromptsOverridable } from '#lib/prompts/override-validation.mjs';
import type { DegradationEvent } from '#lib/degradation/index.mjs';
import { loadBundleFromFiles } from './bundle-loader.mjs';

/** A remote bundle accepted for registration: its recipe plus prompt overrides. */
interface AcceptedBundle {
  label: string;
  recipe: Recipe;
  prompts: Record<string, Record<string, BundlePromptPair>>;
}

// labre-mcp-owned tables live in the labre_mcp schema (1 data-owning system =
// 1 schema); the schema must be listed in PostgREST "Exposed schemas".
const SCHEMA = 'labre_mcp';
const TABLE = 'strategy_bundles';
const BUCKET = 'strategy-bundles';
const DEFAULT_TTL_SECONDS = 300;

// ─── Row contract (untrusted input from Supabase) ───────────────────────────

const BundleFileEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'sha256 must be a 64-char hex digest'),
});

// Non-strict on purpose: extra columns (id, manifest, enabled, created_by, …)
// are stripped. The authoritative manifest is the DOWNLOADED manifest.json,
// integrity-sealed by its sha256 — the row's `manifest` jsonb copy is for the
// admin UI and is deliberately ignored here.
const StrategyBundleRowSchema = z.object({
  slug: z.string().min(1),
  version: z.string().min(1),
  files: z.array(BundleFileEntrySchema).min(1),
  storage_prefix: z.string().min(1),
  updated_at: z.string().min(1),
});

type StrategyBundleRow = z.infer<typeof StrategyBundleRowSchema>;

// ─── Client abstraction (injectable for tests) ──────────────────────────────

/** Cheap change-detection probe: one query, no file downloads. */
export interface BundleListingProbe {
  /** Max `updated_at` among RLS-visible (enabled) rows; null when none. */
  maxUpdatedAt: string | null;
  /** Count of visible rows — catches a bundle being disabled, which removes
   *  it from the RLS-visible set without necessarily moving maxUpdatedAt. */
  enabledCount: number;
}

/** Minimal surface the refresh needs; the default impl adapts supabase-js. */
export interface SupabaseBundleClient {
  probe(): Promise<BundleListingProbe>;
  /** All RLS-visible rows of `strategy_bundles` (unknown: zod-validated by the source). */
  listEnabled(): Promise<unknown[]>;
  /** Download one object from the `strategy-bundles` bucket by full storage path. */
  download(storagePath: string): Promise<Uint8Array>;
}

/**
 * Builds a short-lived client authenticated as the caller. Implementations
 * must not retain the token beyond the returned client's lifetime.
 */
export type SupabaseBundleClientFactory = (bearerToken: string) => Promise<SupabaseBundleClient>;

function buildDefaultClientFactory(
  supabaseUrl: string,
  anonKey: string,
): SupabaseBundleClientFactory {
  return async (bearerToken: string): Promise<SupabaseBundleClient> => {
    // Dynamic import: stdio transport / anon-key-less daemons never pay for
    // (or even resolve) @supabase/supabase-js.
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: SCHEMA },
      // The caller's JWT rides every request; RLS authorizes. The client is
      // discarded after the refresh — the token never outlives it.
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });

    return {
      async probe(): Promise<BundleListingProbe> {
        const { data, error, count } = await client
          .from(TABLE)
          .select('updated_at', { count: 'exact' })
          .order('updated_at', { ascending: false })
          .limit(1);
        if (error) throw new Error(error.message);
        // unknown: untyped supabase-js row — narrowed field by field below.
        const first = (data ?? [])[0] as { updated_at?: unknown } | undefined;
        return {
          maxUpdatedAt: typeof first?.updated_at === 'string' ? first.updated_at : null,
          enabledCount: count ?? 0,
        };
      },
      async listEnabled(): Promise<unknown[]> {
        // RLS already restricts SELECT to enabled rows; the eq() filter is
        // defense in depth against a policy regression.
        const { data, error } = await client
          .from(TABLE)
          .select('slug,version,files,storage_prefix,updated_at')
          .eq('enabled', true);
        if (error) throw new Error(error.message);
        // unknown: rows are untrusted input — zod-validated by the source.
        return (data ?? []) as unknown[];
      },
      async download(storagePath: string): Promise<Uint8Array> {
        const { data, error } = await client.storage.from(BUCKET).download(storagePath);
        if (error) throw new Error(error.message);
        return new Uint8Array(await data.arrayBuffer());
      },
    };
  };
}

// ─── Source ─────────────────────────────────────────────────────────────────

export interface SupabaseBundleSourceOptions {
  supabaseUrl: string;
  /** Public anon key — pairs with the caller's JWT; never a service key. */
  anonKey: string;
  /** Freshness window in seconds (default 300). */
  ttlSeconds?: number;
  /** labre-mcp install root — shipped-recipe collision check on registration. */
  shippedRoot: string;
  /** Injectable for tests; defaults to a dynamic-import supabase-js adapter. */
  clientFactory?: SupabaseBundleClientFactory;
  /** Degradation sink; defaults to a stderr line (the refresh runs in the
   *  request hook, outside any per-tool ambient collector). */
  onDegradation?: (event: DegradationEvent) => void;
}

export interface SupabaseBundleSource {
  /**
   * Refresh the registered bundle recipes if the TTL expired, authenticating
   * to Supabase AS THE CALLER via `bearerToken`. NEVER throws into the
   * request path: on total failure (network down, auth rejected) the
   * previously registered set keeps serving (stale-over-broken) and a
   * degradation event is recorded.
   */
  refreshIfStale(bearerToken: string): Promise<void>;
}

function defaultDegradationSink(event: DegradationEvent): void {
  process.stderr.write(`[labre-mcp] [${event.source}] ${event.severity}: ${event.reason}\n`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function joinStoragePath(prefix: string, relativePath: string): string {
  return `${prefix.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}

export function buildSupabaseBundleSource(
  options: SupabaseBundleSourceOptions,
): SupabaseBundleSource {
  const ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const clientFactory =
    options.clientFactory ?? buildDefaultClientFactory(options.supabaseUrl, options.anonKey);
  const onDegradation = options.onDegradation ?? defaultDegradationSink;

  // Freshness state. `lastAttemptAtMs` throttles successes AND failures by
  // the same TTL: after an outage-degraded attempt we serve stale for one TTL
  // window instead of hammering Supabase on every request.
  let lastAttemptAtMs = Number.NEGATIVE_INFINITY;
  // Snapshot of the last successfully applied listing; null until the first
  // full refresh succeeded (forces a full listing, not just a probe).
  let appliedSnapshot: BundleListingProbe | null = null;
  let inFlight: Promise<void> | null = null;

  function degrade(reason: string, detail?: unknown): void {
    onDegradation({
      source: 'strategy-bundles',
      reason,
      severity: 'warning',
      recoverable: true,
      detail,
      at: new Date().toISOString(),
    });
  }

  /** Download + hash-verify + statically validate one bundle. Throws to reject it. */
  async function loadOneBundle(
    client: SupabaseBundleClient,
    row: StrategyBundleRow,
  ): Promise<AcceptedBundle> {
    const label = `${row.slug}@${row.version}`;

    // All files of a bundle download in parallel; any failure or digest
    // mismatch rejects the WHOLE bundle (tamper-evidence seal).
    const entries = await Promise.all(
      row.files.map(async (file) => {
        const bytes = await client.download(joinStoragePath(row.storage_prefix, file.path));
        const digest = sha256Hex(bytes);
        if (digest !== file.sha256.toLowerCase()) {
          throw new Error(
            `sha256 mismatch for ${file.path} (expected ${file.sha256.toLowerCase()}, got ${digest})`,
          );
        }
        return [file.path.replace(/^\/+/, ''), new TextDecoder('utf-8').decode(bytes)] as const;
      }),
    );
    const contents = new Map<string, string>(entries);

    const validated = await loadBundleFromFiles(label, async (relativePath) => {
      const content = contents.get(relativePath);
      if (content === undefined) {
        throw new Error(`not listed in the bundle "files" manifest`);
      }
      return content;
    });

    // Cross-check the row against the sealed manifest: a row pointing at
    // another bundle's storage prefix must not register under its own slug.
    if (validated.manifest.slug !== row.slug) {
      throw new Error(
        `manifest.json slug ${JSON.stringify(validated.manifest.slug)} does not match row slug ${JSON.stringify(row.slug)}`,
      );
    }

    // Enforce overridability here (same rule as local registerBundle): every
    // declared prompt override must shadow a shipped template prompt. A bundle
    // failing this is rejected like any other bad bundle — the others still load.
    assertBundlePromptsOverridable(validated.prompts, label);

    return { label, recipe: validated.recipe, prompts: validated.prompts };
  }

  async function runRefresh(bearerToken: string): Promise<void> {
    lastAttemptAtMs = Date.now();

    let client: SupabaseBundleClient;
    try {
      client = await clientFactory(bearerToken);
    } catch (err) {
      degrade(`Supabase client init failed — serving previously loaded bundles: ${(err as Error).message}`);
      return;
    }
    // The token is not referenced past this point; the client (which carries
    // it in its headers) goes out of scope when this refresh settles.

    // Cheap probe: if the visible set did not change since the last applied
    // refresh, bump freshness (done via lastAttemptAtMs above) and stop.
    if (appliedSnapshot !== null) {
      let probe: BundleListingProbe;
      try {
        probe = await client.probe();
      } catch (err) {
        degrade(`probe failed — serving previously loaded bundles: ${(err as Error).message}`);
        return;
      }
      if (
        probe.maxUpdatedAt === appliedSnapshot.maxUpdatedAt &&
        probe.enabledCount === appliedSnapshot.enabledCount
      ) {
        return;
      }
    }

    let rawRows: unknown[];
    try {
      rawRows = await client.listEnabled();
    } catch (err) {
      // Total failure: stale-over-broken. The previously registered set keeps
      // serving; never throw into the request path.
      degrade(`listing failed — serving previously loaded bundles: ${(err as Error).message}`);
      return;
    }

    // Per-bundle isolation: each bundle validates independently, a rejected
    // one (bad row, download failure, hash mismatch, static-check failure)
    // does not take the others down (feedback_parallelize_independent).
    const outcomes = await Promise.allSettled(
      rawRows.map(async (raw) => {
        const row = validateOrThrow(StrategyBundleRowSchema, raw, `strategy_bundles row`);
        const label = `${row.slug}@${row.version}`;
        try {
          return await loadOneBundle(client, row);
        } catch (err) {
          throw new Error(`bundle ${label} rejected: ${(err as Error).message}`);
        }
      }),
    );

    const accepted: AcceptedBundle[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') accepted.push(outcome.value);
      else degrade((outcome.reason as Error).message);
    }

    // Atomic swap: reset + re-register run synchronously (no await between),
    // so no concurrent loadRecipe lookup ever observes a half-swapped set. Each
    // bundle's prompt overrides are re-registered alongside its recipe.
    resetBundleRecipes();
    for (const bundle of accepted) {
      try {
        registerBundleRecipe(bundle.recipe, { shippedRoot: options.shippedRoot }, bundle.prompts);
      } catch (err) {
        // Shipped-recipe collision (or duplicate ref between two bundles):
        // reject this bundle, keep the rest.
        degrade(`bundle ${bundle.label} rejected at registration: ${(err as Error).message}`);
      }
    }

    // Applied — remember what the DB looked like for the next probe. The
    // watermark comes from the raw rows we actually saw (rejected bundles
    // included: their updated_at still moves the probe watermark).
    let maxUpdatedAt: string | null = null;
    for (const raw of rawRows) {
      const parsed = StrategyBundleRowSchema.safeParse(raw);
      if (parsed.success && (maxUpdatedAt === null || parsed.data.updated_at > maxUpdatedAt)) {
        maxUpdatedAt = parsed.data.updated_at;
      }
    }
    appliedSnapshot = { maxUpdatedAt, enabledCount: rawRows.length };
  }

  return {
    async refreshIfStale(bearerToken: string): Promise<void> {
      // Concurrent callers share the in-flight refresh instead of stacking
      // clients; runRefresh never rejects, so awaiting it is safe.
      if (inFlight) return inFlight;
      if (Date.now() - lastAttemptAtMs < ttlMs) return;
      inFlight = runRefresh(bearerToken).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
