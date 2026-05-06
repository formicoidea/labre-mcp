// Step 2 of the write:chain:* pipeline — LLM #2.
//
// Given the metadata produced by Step 1, asks the LLM to generate the full
// value chain (anchor + needs + capabilities + dependency links + phase
// seeds). The parser validates the JSON shape with Zod, dedupes components,
// drops orphan links, and rejects cyclic graphs.

import { getPrompt } from '../../../lib/prompts/registry.mjs';
import { tryDegradeAmbient, getCurrentCollector } from '../../../lib/degradation/index.mjs';
import { RawValueChainSchema } from '../../../schemas/value-chain.schema.mjs';
import type {
  ChainMetadata,
  DependencyLink,
  RawValueChain,
  ValueChainComponent,
} from '../../../types/value-chain.mjs';

/** Extract the JSON payload from a raw LLM response, tolerating stray prose
 *  around it by locating the first `{` and last `}`. */
function extractJsonPayload(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`generateChain: no JSON object found in LLM response: ${text.slice(0, 200)}`);
  }
  return text.slice(start, end + 1);
}

/** DFS-based cycle detection over the directed graph formed by `links`. */
function hasCycle(names: ReadonlySet<string>, links: readonly DependencyLink[]): boolean {
  const adj = new Map<string, string[]>();
  for (const name of names) adj.set(name, []);
  for (const { from, to } of links) adj.get(from)!.push(to);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const name of names) color.set(name, WHITE);

  const stack: Array<{ node: string; iter: number }> = [];
  for (const start of names) {
    if (color.get(start) !== WHITE) continue;
    stack.push({ node: start, iter: 0 });
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node)!;
      if (frame.iter >= neighbors.length) {
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const next = neighbors[frame.iter++];
      const c = color.get(next);
      if (c === GRAY) return true;
      if (c === WHITE) {
        color.set(next, GRAY);
        stack.push({ node: next, iter: 0 });
      }
    }
  }
  return false;
}

/** Record a soft warning on the ambient degradation collector if present.
 *  Swallowed silently in unit tests (no ambient collector). */
function warn(source: string, message: string): void {
  const collector = getCurrentCollector();
  if (collector) {
    collector.recordError(source, new Error(message), { recoverable: true, severity: 'warning' });
  }
}

/**
 * Parse the raw LLM response for Step 2. Dedupe components by lowercased
 * trimmed name, drop orphan links with a warn, and throw on cycle.
 */
export function parseRawValueChainResponse(text: string): RawValueChain {
  const payload = extractJsonPayload(text);

  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch (err) {
    throw new Error(`generateChain: invalid JSON in LLM response: ${(err as Error).message}`);
  }

  const parsed = RawValueChainSchema.parse(data);

  // Dedupe components.
  const seen = new Set<string>();
  const components: ValueChainComponent[] = [];
  for (const c of parsed.components) {
    const key = c.name.toLowerCase().trim();
    if (seen.has(key)) {
      warn('llm:write-chain:generate-chain', `duplicate component "${c.name}" dropped`);
      continue;
    }
    seen.add(key);
    components.push(c);
  }

  const nameSet = new Set(components.map(c => c.name));
  const links: DependencyLink[] = [];
  for (const link of parsed.links) {
    if (!nameSet.has(link.from) || !nameSet.has(link.to)) {
      warn(
        'llm:write-chain:generate-chain',
        `orphan link dropped: ${link.from} -> ${link.to}`,
      );
      continue;
    }
    if (link.from === link.to) {
      warn('llm:write-chain:generate-chain', `self-loop dropped on "${link.from}"`);
      continue;
    }
    links.push(link);
  }

  if (hasCycle(nameSet, links)) {
    throw new Error('generateChain: cyclic dependency graph detected in LLM response');
  }

  // Metadata is supplied by the caller (Step 1 output); the schema allows it
  // to be absent here. Fill with a stub so the type-system stays strict; the
  // caller overrides immediately.
  const metadata: ChainMetadata = parsed.metadata ?? {
    title: '', angle: '', scope: '', objective: '', imperatives: [], temporality: 'present', contextSummary: '',
  };

  return { metadata, components, links };
}

// any: llmCall closure shape is provider-dependent (see src/lib/llm)
type LlmCall = any;

/**
 * Invoke LLM #2 to generate the value chain. The returned `RawValueChain`
 * always carries the metadata passed in — the LLM response's own metadata
 * field, if any, is ignored (LLM #1 is the authoritative source).
 */
export async function generateChain(
  metadata: ChainMetadata,
  llmCall: LlmCall,
  today: Date = new Date(),
): Promise<RawValueChain> {
  const p = getPrompt('write-chain', 'generate-chain');
  const date = today.toISOString().slice(0, 10);
  const built = p.build({ metadata: JSON.stringify(metadata), date });

  const response = await tryDegradeAmbient<string | null>(
    'llm:write-chain:generate-chain',
    () => llmCall(built.user, undefined, { systemPrompt: built.system }),
    null,
  );

  if (response == null) {
    throw new Error('generateChain: LLM call degraded (see ambient collector)');
  }

  const chain = p.parse(response) as RawValueChain;
  return { ...chain, metadata };
}
