// PostHog feature flags + telemetry for the HTTP daemon (remote-admin story).
//
// FAIL-OPEN BY DESIGN: a flag that is undefined in PostHog, a PostHog that is
// unreachable, or a daemon with no PostHog configured all mean the recipe is
// ALLOWED. Flags are rollout controls (progressive enablement of recipes per
// user cohort), NOT a security boundary — authentication/authorization is the
// security boundary (Supabase JWT middleware, RLS). Telemetry outages must
// never degrade the request path either: `capture` is fire-and-forget.
//
// `posthog-node` is loaded via dynamic import() inside buildPostHog only, so
// the stdio transport and unconfigured daemons never load the package.
//
// PROMPT EXPERIMENTS: multivariate PostHog flags select a prompt variant per
// strategy. A flag keyed `mcp-prompt-<strategyId>` whose value is a STRING is a
// multivariate variant — and by convention that variant key IS the prompt name
// the caller should load (labre-admin creates the flag variants to match the
// prompt-bundle names). Boolean-valued flags under the same prefix are ignored
// (they are plain rollout toggles, not variant selectors).

/**
 * Structural subset of the posthog-node PostHog client used here.
 * Injectable in tests so no network or real package is needed.
 *
 * `getAllFlags` mirrors posthog-node's
 *   getAllFlags(distinctId: string, options?): Promise<Record<string, FeatureFlagValue>>
 * where `FeatureFlagValue = string | boolean` (@posthog/core). We widen the
 * return with `| undefined` so a defensive/degraded client can signal "no data"
 * without throwing; `Record<string, string | boolean>` remains assignable to it.
 */
export interface PostHogClientLike {
  isFeatureEnabled(key: string, distinctId: string): Promise<boolean | undefined>;
  getAllFlags(distinctId: string): Promise<Record<string, string | boolean> | undefined>;
  capture(message: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;
  shutdown(): Promise<void>;
}

/** 3-segment recipe reference, as addressed by the runRecipe MCP tool. */
export interface RecipeRef {
  domain: string;
  tool: string;
  name: string;
}

export interface PostHogFlags {
  /** Gate: resolve the recipe's rollout flag for a user. Fail-open (see header). */
  isRecipeEnabled(ref: RecipeRef, userId: string | undefined): Promise<boolean>;
  /**
   * Resolve every prompt-experiment variant selected for a user in one call.
   * Keeps only `mcp-prompt-<strategyId>` flags whose value is a string variant,
   * strips the prefix, and returns strategyId → variantName (== prompt name by
   * convention). Fail-open: any error / missing client / no data → `{}`.
   */
  resolvePromptVariants(distinctId: string): Promise<Record<string, string>>;
  /** Fire-and-forget telemetry capture — never throws, never awaited in the request path. */
  capture(event: string, distinctId: string, properties?: Record<string, unknown>): void;
  /** Flush queued telemetry (daemon shutdown path). Swallows client errors. */
  shutdown(): Promise<void>;
}

export interface BuildPostHogOptions {
  apiKey: string;
  /** PostHog ingestion host; defaults to the US cloud. */
  host?: string;
  /** Injectable fake for tests; production callers omit it and get posthog-node. */
  client?: PostHogClientLike;
}

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Flag key convention shared with the labre-admin back-office:
 * `mcp-recipe-<domain>-<tool>-<name>`. PostHog flag keys cannot carry colons,
 * so the 3 recipe segments are joined with dashes (and any stray colon inside
 * a segment is normalised to a dash defensively).
 */
export function recipeFlagKey(ref: RecipeRef): string {
  const clean = (segment: string): string => segment.replaceAll(":", "-");
  return `mcp-recipe-${clean(ref.domain)}-${clean(ref.tool)}-${clean(ref.name)}`;
}

/**
 * Prefix for prompt-experiment flag keys. Exported so callers (and the
 * labre-admin back-office) can invert a flag key back to its strategyId.
 */
export const PROMPT_EXPERIMENT_FLAG_PREFIX = "mcp-prompt-";

/**
 * Flag key for a strategy's prompt experiment, shared with labre-admin:
 * `mcp-prompt-<strategyId>`. PostHog flag keys cannot carry colons, so any stray
 * colon in the strategyId is normalised to a dash defensively (same rule as
 * recipeFlagKey).
 */
export function promptExperimentFlagKey(strategyId: string): string {
  return `${PROMPT_EXPERIMENT_FLAG_PREFIX}${strategyId.replaceAll(":", "-")}`;
}

export function buildPostHog(options: BuildPostHogOptions): PostHogFlags {
  // Lazily-created client: the dynamic import only runs when a configured
  // daemon actually builds the instance. An injected fake short-circuits it.
  const clientPromise: Promise<PostHogClientLike> = options.client
    ? Promise.resolve(options.client)
    : import("posthog-node").then(
        (mod) =>
          new mod.PostHog(options.apiKey, {
            host: options.host ?? DEFAULT_POSTHOG_HOST,
          }),
      );
  // Mark the rejection as handled so a broken import cannot surface as an
  // unhandled rejection; each call site still awaits and fails open itself.
  clientPromise.catch(() => {});

  return {
    async isRecipeEnabled(ref, userId) {
      const key = recipeFlagKey(ref);
      try {
        const client = await clientPromise;
        const enabled = await client.isFeatureEnabled(key, userId ?? "anonymous");
        // `undefined` = flag not defined in PostHog → allowed (fail-open):
        // an operator who never created the flag has not opted into gating.
        return enabled !== false;
      } catch {
        // PostHog unreachable / client broken → allowed (fail-open).
        return true;
      }
    },

    async resolvePromptVariants(distinctId) {
      try {
        const client = await clientPromise;
        const all = await client.getAllFlags(distinctId);
        // No data (undefined) → no variants opted-in (fail-open).
        if (!all) return {};
        const variants: Record<string, string> = {};
        for (const [key, value] of Object.entries(all)) {
          // Only multivariate (string-valued) flags under the prompt prefix are
          // variant selectors; boolean rollout toggles are ignored.
          if (typeof value !== "string") continue;
          if (!key.startsWith(PROMPT_EXPERIMENT_FLAG_PREFIX)) continue;
          const strategyId = key.slice(PROMPT_EXPERIMENT_FLAG_PREFIX.length);
          // The variant name IS the prompt name by convention (see header).
          variants[strategyId] = value;
        }
        return variants;
      } catch {
        // PostHog unreachable / client broken → no variants (fail-open).
        return {};
      }
    },

    capture(event, distinctId, properties) {
      // Fire-and-forget: never awaited on the request path, never throws.
      void clientPromise
        .then((client) => client.capture({ distinctId, event, properties }))
        .catch(() => {});
    },

    async shutdown() {
      try {
        const client = await clientPromise;
        await client.shutdown();
      } catch {
        // Telemetry flush failure must never turn a clean shutdown into a crash.
      }
    },
  };
}
