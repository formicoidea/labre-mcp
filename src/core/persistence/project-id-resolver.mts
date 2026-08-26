// Resolve a stable projectId from a projectRoot path.
//
// Resolution order:
//   1. Read <projectRoot>/.labre/project.json — if present, return its `projectId` field
//   2. Otherwise, derive a deterministic ID from the absolute projectRoot (SHA-1, 16 hex chars)
//
// The .labre/project.json approach lets users assign a stable cross-machine
// project identity (e.g. when the same repo is cloned to different paths or
// machines). The hash fallback ensures we always have an ID even without
// explicit project setup.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export const ProjectMarkerSchema = z.object({
  projectId: z.string().min(1),
});

const cache = new Map<string, string>();

export async function resolveProjectId(projectRoot: string): Promise<string> {
  const absolute = resolve(projectRoot);
  const hit = cache.get(absolute);
  if (hit) return hit;

  const markerPath = join(absolute, ".labre", "project.json");
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed = ProjectMarkerSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      cache.set(absolute, parsed.data.projectId);
      return parsed.data.projectId;
    }
  } catch {
    // Fall through to hash fallback
  }

  const derived = createHash("sha1").update(absolute).digest("hex").slice(0, 16);
  cache.set(absolute, derived);
  return derived;
}

/** Test-only: clear the projectId cache. */
export function resetProjectIdCache(): void {
  cache.clear();
}
