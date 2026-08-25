#!/usr/bin/env tsx
// Import-boundary guard — invariant I2, "transport state stays separate from
// business state" (AI-harness audit, CH-06).
//
// WHAT THE KERNEL IS SUPPOSED TO BE. `src/core/` is the kernel: registry,
// recipe runner, bus, ast, context, persistence. It is the part that survives
// a change of framework AND a change of wire protocol. `src/mcp/` is the wire
// surface — tool descriptors, JSON coercion, MCP-shaped input/output. The
// dependency may only ever point one way: mcp knows about core, core knows
// nothing about mcp. The day that inverts, "run this strategy" stops being
// callable except through an MCP `tools/call`, and the kernel is no longer a
// kernel.
//
// WHY THIS FILE SHIPS RED. Today the transport layer physically lives INSIDE
// the kernel, at `src/core/transport/` (ARCH-14). That is a known misplacement:
// the daemon, the HTTP server, the auth middleware and the boot wiring are
// transport concerns sitting in the business tree, and the boot wiring reaches
// straight into `src/mcp/` — in VALUE, not in type — to build its tool
// registry. The guard does not pretend otherwise. It enumerates every existing
// crossing in scripts/import-boundaries-baseline.json, tolerates exactly
// those, and fails on any NEW one. The baseline is lifted by CH-23, the façade
// refactor that moves transport out of core and inverts the boot dependency.
//
// THREE RULES. The first two are the boundary as it must hold TODAY; the third
// is the one CH-23 exists to repay.
//
//   CORE_TO_MCP        `src/core/` outside transport must not import
//                      `src/mcp/`. Green today, and this is the rule that
//                      actually matters: it keeps the kernel proper clean
//                      while transport is being moved out from under it.
//
//   CORE_TO_TRANSPORT  `src/core/` outside transport must not import
//                      `src/core/transport/`. A kernel module reaching for the
//                      daemon is the same inversion wearing a different hat,
//                      and it is what would make CH-23's extraction hurt.
//
//   TRANSPORT_TO_MCP   `src/core/transport/` must not import `src/mcp/`. This
//                      is the crossing the audit named (`boot-tool-registry`
//                      imports five tool descriptors as values). It is only a
//                      violation BECAUSE transport is currently inside core —
//                      once CH-23 moves transport out, the boot wiring is
//                      allowed to know the tools it wires, and this rule
//                      retires along with its baseline entries.
//
// Run it locally exactly as CI does:  pnpm check:boundaries

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/import-boundaries-baseline.json";

const PERIMETER = "src/core";
const TRANSPORT = "src/core/transport";
const MCP = "src/mcp";
const EXTENSIONS = [".mts", ".ts", ".mjs", ".js"];

type Rule = "CORE_TO_MCP" | "CORE_TO_TRANSPORT" | "TRANSPORT_TO_MCP";

interface Finding {
  file: string;
  line: number;
  rule: Rule;
  specifier: string;
  message: string;
}

interface BaselineEntry {
  file: string;
  rule: Rule;
  specifier: string;
  why?: string;
}

// ─── Subpath alias map ──────────────────────────────────────────────────────
// Read from package.json "imports" under the `labre-mcp-dev` condition — the
// same condition tsx and tsconfig.scripts.json use — rather than hard-coded
// here. A hard-coded copy would silently stop matching the day someone adds or
// renames a `#alias`, and a boundary guard that quietly matches nothing is
// worse than no guard at all.
function aliasMap(): Array<{ prefix: string; target: string }> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    imports?: Record<string, Record<string, string>>;
  };
  const entries: Array<{ prefix: string; target: string }> = [];
  for (const [key, conditions] of Object.entries(pkg.imports ?? {})) {
    if (!key.endsWith("/*")) continue;
    const target = conditions["labre-mcp-dev"];
    if (typeof target !== "string" || !target.endsWith("/*")) continue;
    entries.push({
      prefix: key.slice(0, -1), // "#core/*" → "#core/"
      target: target.replace(/^\.\//, "").slice(0, -1), // "./src/core/*" → "src/core/"
    });
  }
  // Longest prefix first, so "#work-on-value-chain/" is tried before any
  // shorter alias that happens to be a prefix of it.
  return entries.sort((a, b) => b.prefix.length - a.prefix.length);
}

const ALIASES = aliasMap();

// ─── Source scanning ────────────────────────────────────────────────────────
// Comments are blanked before specifiers are read. This is not paranoia: this
// repository documents its own boundaries in prose, and a naive regex over raw
// text reports a sentence about an import as an import.
//
// The one subtlety that matters: in code state a backslash consumes the next
// character. A bare `\` outside a string is a syntax error, so this costs
// nothing — and it is what stops a regex literal such as `/\/*$/` from reading
// as an opening block comment and silently swallowing every import below it.
//
// KNOWN LIMIT: a regex literal containing an unpaired quote (`/'/`) would
// desynchronise the scanner. None exists here; the symptom would be a false
// positive or a skipped file, never a wrong verdict on an existing import.
function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "\\") {
      out.push(" ", src[i + 1] === "\n" ? "\n" : " ");
      i += 2;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      out.push(" ", " ");
      i += 2;
      continue;
    }

    if (c === "'" || c === '"' || c === "`") {
      // Strings are KEPT — a module specifier IS a string. We only walk to the
      // closing quote so the scanner leaves this construct in the right state.
      const quote = c;
      out.push(c);
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out.push(src[i]!, src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out.push(src[i]!);
        i++;
      }
      out.push(quote);
      i++;
      continue;
    }

    out.push(c!);
    i++;
  }
  return out.join("");
}

/** Every module specifier in a file, with its 1-based line. Covers
 *  `import … from 'x'`, bare `import 'x'`, `export … from 'x'`,
 *  `await import('x')` and `require('x')`. */
function specifiersOf(src: string): Array<{ specifier: string; line: number }> {
  const code = stripComments(src);
  const re = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;
  const found: Array<{ specifier: string; line: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    found.push({
      specifier: m[1]!,
      line: code.slice(0, m.index).split("\n").length,
    });
  }
  return found;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) acc.push(full);
  }
  return acc;
}

/** Repo-relative, forward-slashed — the form used in findings and baseline. */
const rel = (abs: string): string => relative(repoRoot, abs).split(sep).join("/");

/** Where a specifier lands, repo-relatively, or null for a bare node_modules
 *  specifier. Extensions are irrelevant here: the rules are about which
 *  DIRECTORY a file reaches into, so `.mjs` vs `.mts` never has to be mapped. */
function resolveTarget(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith(".")) return rel(resolve(dirname(fromFile), specifier));
  for (const { prefix, target } of ALIASES) {
    if (specifier.startsWith(prefix)) return target + specifier.slice(prefix.length);
  }
  return null;
}

const under = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + "/");

function violationFor(fromFile: string, specifier: string): { rule: Rule; message: string } | null {
  const file = rel(fromFile);
  const target = resolveTarget(fromFile, specifier);
  if (target === null) return null;

  const inTransport = under(file, TRANSPORT);

  if (!inTransport && under(target, MCP)) {
    return {
      rule: "CORE_TO_MCP",
      message:
        `imports \`${specifier}\` → ${target}. The kernel must not know the wire ` +
        `surface: src/mcp/ holds MCP tool descriptors and MCP-shaped I/O, and a ` +
        `kernel module that depends on them can no longer be called except ` +
        `through a tools/call. Depend on the core contract instead and let the ` +
        `MCP layer adapt.`,
    };
  }

  if (!inTransport && under(target, TRANSPORT)) {
    return {
      rule: "CORE_TO_TRANSPORT",
      message:
        `imports \`${specifier}\` → ${target}. Transport (daemon, HTTP server, ` +
        `auth, boot wiring) is misplaced inside src/core/ today and CH-23 moves ` +
        `it out; a kernel module that reaches for it turns that move into a ` +
        `breaking change. Extract what you need into a kernel module both sides ` +
        `can import.`,
    };
  }

  if (inTransport && under(target, MCP)) {
    return {
      rule: "TRANSPORT_TO_MCP",
      message:
        `imports \`${specifier}\` → ${target}. src/core/transport/ sits inside ` +
        `the kernel tree, so this is core→mcp by physical location. CH-23 lifts ` +
        `the rule by moving transport out of core; until then, do not add a ` +
        `sixth crossing to the five the baseline already carries.`,
    };
  }

  return null;
}

// ─── Baseline ───────────────────────────────────────────────────────────────
// A literal enumeration — one exact {file, rule, specifier} triple per entry,
// no wildcard and no "at most N" threshold, either of which would let a new
// violation hide behind an old one. An entry matching nothing is itself an
// error (rule STALE): an allow-list that has drifted from the tree it
// describes is how a real violation gets waved through.
function loadBaseline(): { entries: BaselineEntry[]; keys: Map<string, BaselineEntry> } {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, BASELINE), "utf8");
  } catch {
    return { entries: [], keys: new Map() };
  }
  const parsed = JSON.parse(raw) as { violations?: BaselineEntry[] };
  const entries = parsed.violations ?? [];
  const keys = new Map<string, BaselineEntry>();
  for (const e of entries) keys.set(`${e.file}|${e.rule}|${e.specifier}`, e);
  return { entries, keys };
}

// ─── Run ────────────────────────────────────────────────────────────────────
const { entries: baselineEntries, keys: baseline } = loadBaseline();
const hit = new Set<string>();
const failures: Finding[] = [];
const tolerated: Finding[] = [];
let scanned = 0;

let files: string[];
try {
  files = walk(join(repoRoot, PERIMETER));
} catch {
  console.error(`::error::perimeter '${PERIMETER}' not found — run from the repository root`);
  process.exit(1);
}

for (const file of files) {
  scanned++;
  const src = readFileSync(file, "utf8");
  for (const { specifier, line } of specifiersOf(src)) {
    const v = violationFor(file, specifier);
    if (!v) continue;
    const finding: Finding = { file: rel(file), line, specifier, ...v };
    const key = `${finding.file}|${v.rule}|${specifier}`;
    if (baseline.has(key)) {
      hit.add(key);
      tolerated.push(finding);
    } else {
      failures.push(finding);
    }
  }
}

for (const f of failures) {
  console.error(`::error file=${f.file},line=${f.line}::[${f.rule}] ${f.file} ${f.message}`);
}

const stale = [...baseline.keys()].filter((k) => !hit.has(k));
for (const k of stale) {
  console.error(
    `::error file=${BASELINE}::stale baseline entry '${k.split("|").join(" ")}' — ` +
      `it matches no finding; delete the entry.`,
  );
}

if (tolerated.length > 0) {
  console.log(
    `import boundaries: ${tolerated.length} documented deviation(s), tolerated by ${BASELINE} (lifted by CH-23):`,
  );
  for (const t of tolerated) {
    console.log(`  - ${t.file}:${t.line} [${t.rule}] ${t.specifier}`);
  }
}

const failed = failures.length > 0 || stale.length > 0;
if (!failed) {
  console.log(
    `import boundaries: OK (${scanned} files under ${PERIMETER}/, ${baselineEntries.length} baselined)`,
  );
}
process.exit(failed ? 1 : 0);
