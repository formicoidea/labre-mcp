// LABRE_AUTH is an explicit list of auth "doors" (supersedes the old exclusive
// enum + the implicit lab_ rider — see PR #34 follow-up decision on issue #33).
// Every accepted credential family is NAMED in the env, nothing rides silently:
//
//   LABRE_AUTH=supabase,oidc,api-key   all three doors open
//   LABRE_AUTH=api-key                 static lab_ keys only (headless/CI)
//   LABRE_AUTH=oidc                    federated JWT only, no static secret
//   LABRE_AUTH=none / unset / ""       no auth (local dev)
//
// This module is intentionally dependency-free (only reads the env string) so
// both the daemon boot path and the boot health checks can share it without a
// circular import through labre-daemon.mts.

/** An auth door = one credential family the daemon will accept.
 *  Named to match the runtime provenance stamped on the context
 *  (`auth.source: 'supabase' | 'oidc' | 'api-key'`) — one vocabulary. */
export type AuthDoor = "supabase" | "oidc" | "api-key";

const KNOWN_DOORS: readonly AuthDoor[] = ["supabase", "oidc", "api-key"];

/**
 * Parse LABRE_AUTH into the set of enabled doors. Order-independent, whitespace
 * tolerant. `none` (or empty/unset) contributes no door, so an empty result
 * means "no auth". An unrecognized entry throws — fail-closed at boot rather
 * than silently dropping a door the operator thought they had opened.
 */
export function parseAuthDoors(raw: string | undefined = process.env.LABRE_AUTH): Set<AuthDoor> {
  const doors = new Set<AuthDoor>();
  if (!raw) return doors;
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (entry === "none") continue; // explicit no-op token
    if ((KNOWN_DOORS as readonly string[]).includes(entry)) {
      doors.add(entry as AuthDoor);
    } else {
      throw new Error(
        `Invalid LABRE_AUTH entry: "${entry}" (expected a comma-separated list of: ${KNOWN_DOORS.join(", ")}, or "none")`,
      );
    }
  }
  return doors;
}
