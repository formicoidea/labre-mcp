// Stdio transport for labre-mcp (ARCH-14 companion) — the wire, not the surface.
//
// Speaks the MCP protocol over newline-delimited JSON-RPC 2.0 on
// stdin/stdout, the transport Claude Code / the Agent SDK spawn directly
// (`{ "command": "npx", "args": ["-y", "labre-mcp"] }`). It reuses the exact
// same `dispatch` and the same registry instance as the HTTP daemon — only the
// framing differs, so the surface is identical regardless of how the client
// connects.
//
// Since CH-23 the registry ARRIVES as a parameter: `startStdioServer(deps)` is
// a function, and the composition root that decides which tools are served is
// the delivery-side entrypoint (`src/mcp/labre-stdio.mts`).
//
// Protocol invariant: stdout carries ONLY MCP messages (responses + the
// fire-and-forget notifications emitted by src/lib/mcp-notifications.mts).
// Everything else — boot logs, health checks, stray console output — is routed
// to stderr so it never corrupts the JSON-RPC stream.

import { createInterface } from "node:readline";
import { dispatch } from "./mcp-handler.mjs";
import type { ToolRegistry } from "#core/registry/tool-registry.mjs";
import type { PromptRegistry } from "#core/registry/prompt-registry.mjs";
import type { ResourceRegistry } from "#core/registry/resource-registry.mjs";
import type { StrategyRegistry } from "#core/registry/strategy-registry.mjs";
import type { BaseStrategy } from "#core/ast/base-strategy.mjs";
import { JsonRpcRequestSchema, type JsonRpcResponse } from "./json-rpc.schema.mjs";
import { extractContext } from "./context-extractor.mjs";
import { noopAuthMiddleware, type AuthMiddleware } from "./auth-middleware.mjs";
import { registerBootHealthChecks } from "./boot-health-checks.mjs";
import { runAllHealthChecks } from "#lib/degradation/index.mjs";
import { selectPostHog } from "./boot-posthog.mjs";
import { setPostHogFlags } from "#lib/flags/state.mjs";

export interface StdioDeps {
  tools: ToolRegistry;
  /** The MCP costume (CH-24) — passed straight through to dispatch, exactly as
   *  on HTTP, so the two wires expose the same surface (invariant I7). */
  prompts?: PromptRegistry;
  resources?: ResourceRegistry;
  auth?: AuthMiddleware;
}

/**
 * Handle a single raw stdin line. Returns the JSON-RPC response to write back,
 * or `null` for notifications (and blank lines) which produce no output.
 * Parse/validation failures resolve to a JSON-RPC error envelope (id: null)
 * rather than throwing, so the read loop never breaks on malformed input.
 */
export async function handleLine(
  line: string,
  deps: StdioDeps,
): Promise<JsonRpcResponse | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let body: unknown;
  try {
    body = JSON.parse(trimmed);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  }

  const parsed = JsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request", data: parsed.error.issues },
    };
  }

  const auth = deps.auth ?? noopAuthMiddleware;
  const context = await auth.authenticate({}, extractContext(parsed.data.params));
  // "stdio" names the wire for tool telemetry (CH-09): the two transports must
  // emit the same events, and stay TELLABLE APART in the data.
  return dispatch({
    request: parsed.data,
    context,
    tools: deps.tools,
    prompts: deps.prompts,
    resources: deps.resources,
    transport: "stdio",
  });
}

function writeMessage(message: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/** What the delivery layer hands the stdio server — same contract as the HTTP
 *  daemon's `HttpDaemonDeps`: both registries are built by the caller. */
export interface StdioServerDeps {
  tools: ToolRegistry;
  strategies: StrategyRegistry<BaseStrategy>;
  /** The MCP costume (CH-24 / ARCH-28) — same optionality as on HTTP. */
  prompts?: PromptRegistry;
  resources?: ResourceRegistry;
}

export async function startStdioServer(deps: StdioServerDeps): Promise<void> {
  // Guard the protocol channel: redirect any stray console.* writes to stderr.
  // Intentional protocol writes go through process.stdout.write directly
  // (here and in mcp-notifications.mts) and are unaffected.
  console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
  console.info = console.log;
  console.debug = console.log;

  const { tools, strategies, prompts, resources } = deps;

  // PostHog feature flags + telemetry — SAME condition as the HTTP daemon
  // (POSTHOG_API_KEY set), because telemetry is a property of the process, not
  // of the transport (CH-09, invariant I7). Installed BEFORE the read loop so
  // the very first tools/call already sees the singleton.
  const posthog = await selectPostHog();
  if (posthog) {
    setPostHogFlags(posthog);
    // Metadata only — no payloads, no user content. stdio never authenticates,
    // so the distinct id is the same constant the rest of the process uses.
    posthog.capture("mcp_boot", "daemon", {
      transport: "stdio",
      tools: tools.list().length,
      prompts: prompts?.size() ?? 0,
      resources: resources?.size() ?? 0,
      strategies: strategies.size(),
    });
  }

  process.stderr.write(
    `[labre-mcp] stdio transport ready (newline-delimited JSON-RPC on stdin/stdout)\n`,
  );
  process.stderr.write(
    `[labre-mcp] Tools registered: ${tools.list().map((t) => t.name).join(", ") || "(none)"}\n`,
  );
  process.stderr.write(
    `[labre-mcp] Prompts registered: ${prompts ? prompts.list().map((p) => p.name).join(", ") || "(none)" : "(no prompt registry)"}\n`,
  );
  process.stderr.write(
    `[labre-mcp] Resources registered: ${resources ? resources.list().map((r) => r.uri).join(", ") || "(none)" : "(no resource registry)"}\n`,
  );
  process.stderr.write(`[labre-mcp] Strategies registered: ${strategies.size()}\n`);
  process.stderr.write(
    `[labre-mcp] PostHog: ${posthog ? "enabled (recipe flags + telemetry)" : "disabled (POSTHOG_API_KEY not set — flags fail open, no telemetry)"}\n`,
  );

  // Boot health checks (config/env presence only — no network). Never blocks boot.
  registerBootHealthChecks();
  const healthEvents = await runAllHealthChecks();
  if (healthEvents.length === 0) {
    process.stderr.write("[labre-mcp] Health checks: all dependencies ready\n");
  } else {
    process.stderr.write(
      `[labre-mcp] Health checks — ${healthEvents.length} dependency(ies) degraded:\n${healthEvents
        .map((e) => `  - ${e.source}: ${e.reason}`)
        .join("\n")}\n`,
    );
  }

  // Telemetry lifecycle on stdio (CH-09). posthog-node BUFFERS: capture() only
  // queues, and a stdio server is killed far more brutally than a daemon — the
  // client closes the pipe or signals the moment the conversation ends. Without
  // an explicit flush the last batch of events dies with the process, which
  // would have made the stdio numbers wrong in a way that LOOKS like low usage
  // instead of like a bug. Every exit path goes through here.
  const flushAndExit = async (code: number): Promise<never> => {
    // shutdown() swallows client errors: a telemetry flush failure must never
    // turn a clean exit into a crash (same contract as the daemon's shutdown).
    if (posthog) await posthog.shutdown();
    process.exit(code);
  };
  process.on("SIGINT", () => void flushAndExit(0));
  process.on("SIGTERM", () => void flushAndExit(0));

  // Sequential read loop. `for await` awaits each dispatch before reading the
  // next line, which both honours the V1 synchronous model (ARCH-11) and keeps
  // stdout writes from interleaving across concurrent calls.
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const response = await handleLine(line, { tools, prompts, resources });
    if (response !== null) writeMessage(response);
  }

  // stdin closed (EOF) — the client disconnected. Flush, then exit cleanly.
  await flushAndExit(0);
}
