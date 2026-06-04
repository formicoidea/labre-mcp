// Shared RequestContext resolution for MCP tool handlers (ARCH-15).
//
// A handler receives the dispatch-provided context (or `_context` envelope).
// When it parses as a valid RequestContext it is used as-is; otherwise a
// dev-mode fallback derives a projectId from the current working directory.
// Production callers should always supply a context.

import { randomUUID } from 'node:crypto';
import { resolveProjectId } from '#core/persistence/project-id-resolver.mjs';
import { type RequestContext, RequestContextSchema } from '#core/context/request-context.mjs';

export async function resolveContext(rawContext: unknown): Promise<RequestContext> {
  if (rawContext && typeof rawContext === 'object') {
    const parsed = RequestContextSchema.safeParse(rawContext);
    if (parsed.success) return parsed.data;
  }
  // Dev-mode fallback: derive projectId from current working dir as a hash.
  // ARCH-15: process.cwd() is acceptable here only because the daemon
  // captures it at boot — production callers should always supply a context.
  const projectRoot = process.cwd();
  const projectId = await resolveProjectId(projectRoot);
  return {
    projectId,
    projectRoot,
    sessionId: randomUUID(),
    domain: 'wardley',
  };
}
