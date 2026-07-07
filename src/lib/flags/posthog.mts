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

/**
 * Structural subset of the posthog-node PostHog client used here.
 * Injectable in tests so no network or real package is needed.
 */
export interface PostHogClientLike {
  isFeatureEnabled(key: string, distinctId: string): Promise<boolean | undefined>;
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
