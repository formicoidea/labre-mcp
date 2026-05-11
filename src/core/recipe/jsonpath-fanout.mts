// Thin wrapper around jsonpath-plus to read and write into an AST using
// JSONPath expressions. Used by the recipe runner for `in`, `out`, `over`.
// Default paths in the runner use $ (root) and $.lastResult (scratch slot).

import { JSONPath } from "jsonpath-plus";

export function readPath(ast: unknown, path: string): unknown {
  // any: JSONPath returns mixed array/scalar shapes — we normalise to first match
  const matches = JSONPath({ path, json: ast as object, wrap: false });
  return matches;
}

export function writePath(ast: unknown, path: string, value: unknown): void {
  if (path === "$" || path === "$.") {
    throw new Error("Cannot write to root path '$'");
  }
  if (ast === null || typeof ast !== "object") {
    throw new Error(`writePath: root must be a non-null object, got ${ast === null ? "null" : typeof ast}`);
  }
  const segments = parsePath(path);
  let cursor: Record<string, unknown> = ast as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (cursor[seg] === undefined || cursor[seg] === null) {
      cursor[seg] = {};
    }
    const next = cursor[seg];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(
        `writePath: cannot descend through "${seg}" — value is ${
          Array.isArray(next) ? "array" : typeof next
        } (path "${path}")`,
      );
    }
    cursor = next as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

// Parse a simple dot-path like $.a.b.c into ["a", "b", "c"]. Bracket and
// filter syntax are not supported for writes (read still uses full JSONPath).
function parsePath(path: string): string[] {
  if (!path.startsWith("$")) {
    throw new Error(`Path must start with '$': "${path}"`);
  }
  const trimmed = path.slice(1);
  const cleaned = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
  if (cleaned.length === 0) return [];
  return cleaned.split(".").map((s) => s.trim()).filter((s) => s.length > 0);
}
