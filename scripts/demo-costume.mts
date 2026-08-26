#!/usr/bin/env tsx
// DEMO — what a third-party harness actually receives from the costume
// (CH-24 / ARCH-28).
//
// Runs the real stdio line handler against the real composed surface: the
// handshake, then prompts/list, then prompts/get, then resources/list, then
// resources/read on two documents. Same code path Claude Code drives when it
// spawns `npx labre-mcp` — only the pipe is missing.
//
// NO MODEL, NO NETWORK, NO PORT. Prompts render shipped text, resources read
// shipped files. Safe to run anywhere, any time.
//
//   pnpm exec tsx --conditions labre-mcp-dev scripts/demo-costume.mts

import { handleLine } from "#transport/stdio-server.mjs";
import { buildMcpToolRegistry } from "#mcp/tool-registry.mjs";
import { buildMcpPromptRegistry } from "#mcp/prompt-registry.mjs";
import { buildMcpResourceRegistry } from "#mcp/resource-registry.mjs";
import { buildStrategyRegistry } from "#frameworks/registry-boot.mjs";

const strategies = buildStrategyRegistry();
const deps = {
  tools: buildMcpToolRegistry(),
  prompts: buildMcpPromptRegistry(),
  resources: await buildMcpResourceRegistry({ strategies }),
};

let id = 0;
async function call(method: string, params?: unknown): Promise<unknown> {
  id += 1;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const response = await handleLine(line, deps);
  // any: the demo prints whatever the wire returns
  return (response as { result?: unknown } | null)?.result;
}

function section(title: string): void {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

/** Keep the transcript readable: long documents are shown head-first. */
function head(text: string, lines: number): string {
  const parts = text.split("\n");
  return parts.length <= lines
    ? text
    : `${parts.slice(0, lines).join("\n")}\n… (${parts.length - lines} more lines)`;
}

section("1. initialize — what the server says it can do");
console.log(JSON.stringify(await call("initialize"), null, 2));

section("2. prompts/list — the METHOD surface");
// any: demo shaping only
const prompts = (await call("prompts/list")) as { prompts: any[] };
for (const prompt of prompts.prompts) {
  const args = prompt.arguments
    .map((a: { name: string; required: boolean }) => (a.required ? `${a.name}*` : a.name))
    .join(", ");
  console.log(`\n  ${prompt.name}\n    ${prompt.title}\n    args: ${args}   (* = required)`);
}

section("3. prompts/get identify-capability — the method, rendered");
// any: demo shaping only
const got = (await call("prompts/get", {
  name: "identify-capability",
  arguments: {
    component: "Tea kettle",
    description: "Heats water for the tea shop's drinks",
    context: "A high-street tea shop",
  },
})) as { description: string; messages: any[] };
console.log(`description: ${got.description}`);
got.messages.forEach((message: { role: string; content: { text: string } }, index: number) => {
  console.log(`\n  [${index}] role=${message.role}`);
  console.log(
    head(message.content.text, 12)
      .split("\n")
      .map((l) => `      ${l}`)
      .join("\n"),
  );
});

section("4. resources/list — the KNOWLEDGE surface");
// any: demo shaping only
const resources = (await call("resources/list")) as { resources: any[] };
for (const resource of resources.resources) {
  console.log(`  ${resource.uri.padEnd(32)} ${resource.mimeType.padEnd(24)} ${resource.title}`);
}

section("5. resources/read labre://methods — the live catalogue");
// any: demo shaping only
const methods = (await call("resources/read", { uri: "labre://methods" })) as { contents: any[] };
const catalogue = JSON.parse(methods.contents[0].text) as {
  counts: Record<string, number>;
  methods: Array<{ methodId: string; implementation: string; disabledReason?: string }>;
};
console.log(`counts: ${JSON.stringify(catalogue.counts)}`);
console.log("\nfirst real strategies:");
for (const entry of catalogue.methods.filter((m) => m.implementation === "real").slice(0, 5)) {
  console.log(`  ${entry.methodId}`);
}
const disabled = catalogue.methods.filter((m) => m.disabledReason !== undefined);
console.log(`\ndisabled (${disabled.length}):`);
for (const entry of disabled) console.log(`  ${entry.methodId} — ${entry.disabledReason}`);

section("6. resources/read labre://grammar — how to address a capability");
// any: demo shaping only
const grammar = (await call("resources/read", { uri: "labre://grammar" })) as { contents: any[] };
console.log(head(grammar.contents[0].text, 22));

section("7. an unknown id answers a clean JSON-RPC error");
for (const request of [
  { method: "prompts/get", params: { name: "no-such-prompt" } },
  { method: "resources/read", params: { uri: "labre://no-such-resource" } },
]) {
  id += 1;
  const response = await handleLine(
    JSON.stringify({ jsonrpc: "2.0", id, ...request }),
    deps,
  );
  console.log(`  ${request.method} → ${JSON.stringify((response as { error?: unknown })?.error)}`);
}

console.log("");
