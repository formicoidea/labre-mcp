// Error narrowing helpers for `catch (e: unknown)` under strict TS.
//
// In strict mode, `catch (e)` types `e` as `unknown`, so `e.message` is a
// type error. These helpers narrow once and return safe primitives.

/**
 * Extract a human-readable message from an unknown caught value.
 * Falls back to String(e) for non-Error throws (e.g. thrown strings).
 */
export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e !== null && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    return typeof m === 'string' ? m : String(m);
  }
  return String(e);
}

/** True if `e` is an Error (or Error-shaped) and its `.code` matches. */
export function isErrorCode(e: unknown, code: string): boolean {
  if (e === null || typeof e !== 'object') return false;
  return (e as { code?: unknown }).code === code;
}

/** Extract a `.code` field from a caught value, or undefined. */
export function errorCode(e: unknown): string | undefined {
  if (e === null || typeof e !== 'object') return undefined;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}
