// LIB MODE — the façade's acceptance test (CH-23 / ARCH-27).
//
// The arbitration behind CH-23 says labre-mcp is a product consumable outside
// MCP. That claim is only true if it is CHECKABLE, and it is checkable in two
// ways, both here:
//
//   1. STATICALLY — the transitive import graph of `src/index.mts` contains no
//      file under `src/transport/` and none under `src/mcp/`. A daemon that
//      merely happens not to be *started* is not a library; a daemon that is
//      not even *reachable* is.
//   2. AT RUNTIME — importing the entry, building the full strategy registry
//      and running a deterministic command touches no network at all. `fetch`
//      is replaced by a throwing stub for the whole run: a quota check, a
//      ledger write or a remote bundle refresh would fail the test loudly
//      rather than quietly costing a round-trip.
//
// The command chosen (`render:wardley-map:owm:parse:dsl`) is a pure parse: no
// LLM, no disk, no clock beyond the one injected below.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStrategyRegistry,
  runCommand,
  StrategyRegistry,
  ToolRegistry,
  RequestContextSchema,
  SHIPPED_ROOT,
  type RequestContext,
} from "./index.mjs";
import * as libEntry from "./index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Static graph walk ──────────────────────────────────────────────────────

/** package.json "imports" under the dev condition — the same map tsx uses.
 *  Read rather than hard-coded, so a renamed alias cannot silently make this
 *  walk stop following edges (a graph check that follows nothing always passes). */
function aliasMap(): Array<{ prefix: string; target: string }> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    imports?: Record<string, Record<string, string>>;
  };
  return Object.entries(pkg.imports ?? {})
    .filter(([key]) => key.endsWith("/*"))
    .map(([key, conditions]) => ({
      prefix: key.slice(0, -1),
      target: (conditions["labre-mcp-dev"] ?? "").replace(/^\.\//, "").slice(0, -1),
    }))
    .filter((e) => e.target.length > 0)
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

const ALIASES = aliasMap();

/** Static import edges of a source file. Anchored at line starts and stopped at
 *  the first `;`, so a prose line inside a comment block cannot be read as an
 *  import — this repository documents its own boundaries, and a naive scan
 *  reports a sentence ABOUT an import as an import. */
function edgesOf(src: string): string[] {
  const found = new Set<string>();
  const withFrom = /^\s*(?:import|export)\b[^;]{0,400}?from\s*["']([^"']+)["']/gm;
  const sideEffect = /^\s*import\s*["']([^"']+)["']/gm;
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']/g;
  for (const re of [withFrom, sideEffect, dynamic]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) found.add(m[1]!);
  }
  return [...found];
}

const CANDIDATE_SUFFIXES = ["", ".mts", ".mjs", ".ts", ".js", "/index.mts", "/index.mjs"];

/** Absolute path of a specifier's source file, or null for a bare (node_modules
 *  or node:) specifier and for anything with no source on disk. `.mjs` is the
 *  written form; `.mts` is the file that exists in dev. */
function resolveSource(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    const alias = ALIASES.find((a) => specifier.startsWith(a.prefix));
    if (!alias) return null; // bare: node: builtin or node_modules
    base = join(repoRoot, alias.target + specifier.slice(alias.prefix.length));
  }
  const stripped = base.replace(/\.mjs$/, "");
  for (const candidate of [base, stripped]) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const full = candidate + suffix;
      if (existsSync(full) && !full.endsWith(sep)) {
        try {
          if (readFileSync(full).length >= 0) return full;
        } catch {
          /* a directory — keep trying */
        }
      }
    }
  }
  return null;
}

/** Every repo file reachable from `entry` through static imports. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!/\.(mts|ts|mjs|js)$/.test(file)) continue;
    for (const specifier of edgesOf(src)) {
      const target = resolveSource(file, specifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen].map((f) => relative(repoRoot, f).split(sep).join("/"));
}

describe("lib mode — the kernel is reachable without the delivery", () => {
  const graph = reachableFrom(join(repoRoot, "src", "index.mts"));

  it("walks a real graph (guards against a scan that follows nothing)", () => {
    assert.ok(
      graph.length > 30,
      `expected the lib entry to reach the kernel and the frameworks, got ${graph.length} files`,
    );
    assert.ok(graph.includes("src/core/recipe/recipe-runner.mts"));
    assert.ok(graph.includes("src/frameworks/registry-boot.mts"));
  });

  it("reaches no transport module", () => {
    const offenders = graph.filter((f) => f.startsWith("src/transport/"));
    assert.deepEqual(
      offenders,
      [],
      "the lib entry must not pull in a server — see ARCH-27, first cut",
    );
  });

  it("reaches no MCP delivery module", () => {
    const offenders = graph.filter((f) => f.startsWith("src/mcp/"));
    assert.deepEqual(
      offenders,
      [],
      "the lib entry must not pull in the MCP surface — MCP is one delivery, not the identity",
    );
  });

  it("exports the kernel and none of the servers", () => {
    for (const name of ["runCommand", "runRecipe", "buildStrategyRegistry", "StrategyRegistry"]) {
      assert.ok(name in libEntry, `lib mode must expose ${name}`);
    }
    for (const name of ["startHttpDaemon", "startStdioServer", "dispatch", "buildMcpToolRegistry"]) {
      assert.equal(name in libEntry, false, `lib mode must NOT expose ${name}`);
    }
  });
});

// ─── Runtime: a deterministic run, offline ──────────────────────────────────

const context: RequestContext = {
  projectId: "lib-mode",
  projectRoot: repoRoot,
  sessionId: "lib-mode-session",
  domain: "render",
};

const DSL = "title Lib Mode\ncomponent Customer [0.9, 0.5]\ncomponent Platform [0.4, 0.7]";

describe("lib mode — a run with no transport and no network", () => {
  // any: the global fetch signature is irrelevant here — the stub only throws.
  let realFetch: typeof globalThis.fetch;
  let fetchCalls = 0;

  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls++;
      throw new Error(`lib mode made a network call: ${String(args[0])}`);
    }) as unknown as typeof globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  it("builds the full strategy catalogue without a daemon", () => {
    const registry = buildStrategyRegistry();
    assert.ok(registry instanceof StrategyRegistry);
    assert.ok(registry.size() > 20, `expected a populated catalogue, got ${registry.size()}`);
    assert.equal(fetchCalls, 0);
  });

  it("runs a command and returns a JSON-labre envelope", async () => {
    const outcome = await runCommand({
      command: "render:wardley-map:owm:parse:dsl",
      input: { dsl: DSL },
      context,
      registry: buildStrategyRegistry(),
      // No `hooks`: no quota gate, no ledger row. That is the fourth cut.
    });

    const written = outcome.ast.result as {
      result: { parsed: boolean; map: { title: string; components: unknown[] } };
    };
    assert.equal(written.result.parsed, true);
    assert.equal(written.result.map.title, "Lib Mode");
    assert.equal(written.result.map.components.length, 2);

    assert.equal(outcome.envelope.trace.length, 1);
    assert.equal(outcome.envelope.trace[0]!.command, "render:wardley-map:owm:parse:dsl");
    assert.ok(outcome.events.some((e) => e.phase === "run-end"));
    assert.equal(fetchCalls, 0, "a lib-mode run must make no network call");
  });

  it("is deterministic under an injected clock", async () => {
    const registry = buildStrategyRegistry();
    const clock = {
      now: () => new Date("2026-08-26T00:00:00.000Z"),
      newId: () => "fixed-run-id",
    };
    const run = () =>
      runCommand({
        command: "render:wardley-map:owm:parse:dsl",
        input: { dsl: DSL },
        context,
        registry,
        clock,
      });

    const [first, second] = [await run(), await run()];
    assert.equal(first.recipeRunId, "fixed-run-id");
    // The runner's own stamps — run id, trace timestamps, durations — are what
    // RunClock covers, and they must match byte for byte.
    assert.deepEqual(second.envelope.trace, first.envelope.trace);
    // The business output must match too. The AST as a whole deliberately does
    // NOT: a strategy stamps `capturedAt` on its own signals from the real wall
    // clock, which RunClock explicitly does not reach into (see its comment in
    // recipe-runner.mts). Comparing the parsed map is the honest assertion.
    const mapOf = (o: typeof first) =>
      (o.ast.result as { result: { map: unknown } }).result.map;
    assert.deepEqual(mapOf(second), mapOf(first));
    assert.equal(fetchCalls, 0);
  });

  it("still exposes the contracts a host needs", () => {
    assert.ok(SHIPPED_ROOT.length > 0);
    assert.equal(RequestContextSchema.safeParse(context).success, true);
    // The kernel's tool registry is constructible with no wire in sight.
    const tools = new ToolRegistry();
    tools.register({
      name: "noop",
      description: "host-defined callable",
      inputSchema: { type: "object" },
      async handler() {
        return { ok: true };
      },
    });
    assert.equal(tools.list().length, 1);
    assert.equal(fetchCalls, 0);
  });
});
