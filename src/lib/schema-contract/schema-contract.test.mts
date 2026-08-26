// THE MECHANICAL HALF OF ARCH-26 — labre_mcp schema drift becomes a red test.
//
// WHAT IS BEING GUARDED. This repository codes against a Postgres schema whose
// migrations live in ANOTHER repository (labre, supabase/migrations/). That is
// the arbitrated arrangement, not an accident: the Supabase project belongs to
// labre, and the Supabase CLI accepts exactly one migration chain per project.
// What was missing was any coupling at all. A column renamed, a policy widened,
// an EXECUTE grant revoked on the labre side shipped green there and reached
// labre-mcp as a production incident. `labre-mcp.contract.json` states what this
// code needs; this file compares that statement to a real database.
//
// HOW IT RUNS. Against the LOCAL Supabase stack, two ways, tried in order:
//
//   1. SUPABASE_DB_URL + a `psql` on PATH. The URL's host is asserted LOOPBACK
//      before a single byte is sent — a .env pointing at the real project must
//      never reach this file. (A vitest run has already touched a real project
//      once in the sibling repo; the lesson transfers.)
//   2. `docker exec <container> psql` — container from
//      LABRE_MCP_SCHEMA_DB_CONTAINER, default supabase_db_labre. `docker exec`
//      cannot reach a remote host by construction, so there is nothing to guard.
//
// With neither available the suite SKIPS, loudly, and `pnpm test` is otherwise
// unchanged. It is not wired into CI: CI has no Supabase stack, and pretending
// otherwise is how a guard becomes decoration.
//
// READ-ONLY. Every statement is a catalogue read. This file creates nothing,
// drops nothing, and touches no row.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = join(HERE, 'labre-mcp.contract.json');
const DEFAULT_CONTAINER = 'supabase_db_labre';

// ─── the contract, as declared ──────────────────────────────────────────────

interface ContractColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string;
}
interface ContractPolicy {
  name: string;
  cmd: string;
  roles: string;
}
interface ContractTable {
  name: string;
  rls: boolean;
  columns: ContractColumn[];
  constraints: string[];
  grants: string[];
  policies: ContractPolicy[];
}
interface ContractFunction {
  name: string;
  args: string;
  definer: boolean;
  execute: string[];
}
interface Contract {
  schema: string;
  schemaUsage: string[];
  tables: ContractTable[];
  functions: ContractFunction[];
}

/** The live shape, as introspected. Same field names on purpose: the SQL below
 *  is written to answer in the contract's own vocabulary. */
interface LiveTable {
  name: string;
  rls: boolean | null;
  columns: ContractColumn[] | null;
  constraints: string[] | null;
  grants: string[] | null;
  policies: ContractPolicy[] | null;
}
interface LiveShape {
  schemaUsage: string[] | null;
  tables: LiveTable[] | null;
  functions: (ContractFunction & { execute: string[] | null })[] | null;
}

// ─── reaching a database, or refusing to ────────────────────────────────────

type Runner = (sql: string) => string;

function assertLoopback(dbUrl: string): void {
  const host = new URL(dbUrl).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `schema-contract.test.mts refuses a non-loopback SUPABASE_DB_URL (${host}). ` +
        'This suite runs against the local Supabase stack only.',
    );
  }
}

function tryRunner(argv: string[]): Runner | null {
  const runner: Runner = (sql: string) =>
    execFileSync(argv[0]!, [...argv.slice(1), '-At', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    });
  try {
    // Cheapest possible liveness probe; also proves the binary exists.
    if (runner('select 1').trim() !== '1') return null;
    return runner;
  } catch {
    return null;
  }
}

function resolveRunner(): { run: Runner; how: string } | null {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (dbUrl) {
    // Throws — deliberately. A misconfigured environment must fail loudly here
    // rather than silently fall through to the container and look fine.
    assertLoopback(dbUrl);
    const run = tryRunner(['psql', dbUrl]);
    if (run) return { run, how: 'psql via SUPABASE_DB_URL (loopback checked)' };
  }
  const container = process.env.LABRE_MCP_SCHEMA_DB_CONTAINER ?? DEFAULT_CONTAINER;
  const run = tryRunner(['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', 'postgres']);
  if (run) return { run, how: `docker exec ${container}` };
  return null;
}

// ─── introspection ──────────────────────────────────────────────────────────

// One statement, one JSON answer, shaped like the contract. Everything it reads
// is pg_catalog / information_schema.
const INTROSPECT_SQL = `
with cols as (
  select table_name,
         json_agg(json_build_object(
           'name', column_name, 'type', udt_name,
           'nullable', (is_nullable = 'YES'),
           'default', coalesce(column_default, '')
         ) order by ordinal_position) j
  from information_schema.columns
  where table_schema = 'labre_mcp' group by table_name),
cons as (
  select c.conrelid::regclass::text as t,
         json_agg(pg_get_constraintdef(c.oid) order by pg_get_constraintdef(c.oid)) j
  from pg_constraint c
  where c.connamespace = 'labre_mcp'::regnamespace and c.contype in ('p','u','f')
  group by 1),
rls as (
  select c.relname t, c.relrowsecurity r from pg_class c
  where c.relnamespace = 'labre_mcp'::regnamespace and c.relkind = 'r'),
gr as (
  select table_name t, json_agg(distinct grantee || ':' || privilege_type) j
  from information_schema.role_table_grants
  where table_schema = 'labre_mcp'
    and grantee in ('anon','authenticated','service_role')
    and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
  group by 1),
pol as (
  select tablename t,
         json_agg(json_build_object('name', policyname, 'cmd', cmd, 'roles', roles::text)
                  order by policyname) j
  from pg_policies where schemaname = 'labre_mcp' group by 1),
roles(r) as (values ('anon'),('authenticated'),('service_role')),
fns as (
  select json_agg(json_build_object(
           'name', p.proname,
           'args', pg_get_function_identity_arguments(p.oid),
           'definer', p.prosecdef,
           'execute', (select json_agg(roles.r order by roles.r) from roles
                       where has_function_privilege(roles.r, p.oid, 'EXECUTE'))
         ) order by p.proname) j
  from pg_proc p where p.pronamespace = 'labre_mcp'::regnamespace),
sch as (
  select json_agg(roles.r order by roles.r) j from roles
  where has_schema_privilege(roles.r, 'labre_mcp', 'USAGE'))
select json_build_object(
  'schemaUsage', (select j from sch),
  'tables', (select json_agg(json_build_object(
      'name', cols.table_name,
      'columns', cols.j,
      'constraints', (select cons.j from cons where cons.t = 'labre_mcp.' || cols.table_name),
      'rls', (select rls.r from rls where rls.t = cols.table_name),
      'grants', (select gr.j from gr where gr.t = cols.table_name),
      'policies', (select pol.j from pol where pol.t = cols.table_name)
    ) order by cols.table_name) from cols),
  'functions', (select j from fns));
`;

// ─── the comparison ─────────────────────────────────────────────────────────

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const setEq = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && sorted(a).every((v, i) => v === sorted(b)[i]);

function diffSets(
  where: string,
  expected: readonly string[],
  actual: readonly string[],
  out: string[],
): void {
  for (const e of expected) {
    if (!actual.includes(e)) out.push(`${where}: MISSING \`${e}\``);
  }
  for (const a of actual) {
    if (!expected.includes(a)) out.push(`${where}: UNEXPECTED \`${a}\``);
  }
}

/** Every way the live schema may differ from the contract, as human sentences.
 *  Empty array = the two agree. Exported shape is deliberately plain strings:
 *  the assertion message IS the diagnosis. */
function diffContract(contract: Contract, live: LiveShape): string[] {
  const out: string[] = [];

  diffSets('schema usage', contract.schemaUsage, live.schemaUsage ?? [], out);

  const liveTables = live.tables ?? [];
  diffSets(
    'tables',
    contract.tables.map(t => t.name),
    liveTables.map(t => t.name),
    out,
  );

  for (const expected of contract.tables) {
    const actual = liveTables.find(t => t.name === expected.name);
    if (!actual) continue; // already reported as MISSING
    const at = `${contract.schema}.${expected.name}`;

    if (actual.rls !== expected.rls) {
      out.push(`${at}: RLS is ${actual.rls === true ? 'ON' : 'OFF'}, contract says ${expected.rls ? 'ON' : 'OFF'}`);
    }

    const liveCols = actual.columns ?? [];
    diffSets(
      `${at} columns`,
      expected.columns.map(c => c.name),
      liveCols.map(c => c.name),
      out,
    );
    for (const ec of expected.columns) {
      const ac = liveCols.find(c => c.name === ec.name);
      if (!ac) continue;
      if (ac.type !== ec.type) {
        out.push(`${at}.${ec.name}: type is \`${ac.type}\`, contract says \`${ec.type}\``);
      }
      if (ac.nullable !== ec.nullable) {
        out.push(`${at}.${ec.name}: ${ac.nullable ? 'NULLABLE' : 'NOT NULL'}, contract says the opposite`);
      }
      if (ac.default !== ec.default) {
        out.push(`${at}.${ec.name}: default is \`${ac.default || '(none)'}\`, contract says \`${ec.default || '(none)'}\``);
      }
    }

    diffSets(`${at} constraints`, expected.constraints, actual.constraints ?? [], out);
    // Grants are the security-relevant half: an UNEXPECTED one is not tidiness,
    // it is a role that can suddenly read or write this table.
    diffSets(`${at} grants`, expected.grants, actual.grants ?? [], out);

    const livePolicies = actual.policies ?? [];
    diffSets(
      `${at} policies`,
      expected.policies.map(p => p.name),
      livePolicies.map(p => p.name),
      out,
    );
    for (const ep of expected.policies) {
      const ap = livePolicies.find(p => p.name === ep.name);
      if (!ap) continue;
      if (ap.cmd !== ep.cmd || ap.roles !== ep.roles) {
        out.push(
          `${at} policy "${ep.name}": is ${ap.cmd} to ${ap.roles}, contract says ${ep.cmd} to ${ep.roles}`,
        );
      }
    }
  }

  const liveFns = live.functions ?? [];
  const sig = (f: { name: string; args: string }): string => `${f.name}(${f.args})`;
  diffSets('functions', contract.functions.map(sig), liveFns.map(sig), out);
  for (const ef of contract.functions) {
    const af = liveFns.find(f => sig(f) === sig(ef));
    if (!af) continue;
    if (af.definer !== ef.definer) {
      out.push(`${sig(ef)}: SECURITY ${af.definer ? 'DEFINER' : 'INVOKER'}, contract says the opposite`);
    }
    if (!setEq(ef.execute, af.execute ?? [])) {
      out.push(
        `${sig(ef)} EXECUTE: holders are [${sorted(af.execute ?? []).join(', ') || 'none'}], ` +
          `contract says [${sorted(ef.execute).join(', ')}]`,
      );
    }
  }

  return out;
}

// ─── the suite ──────────────────────────────────────────────────────────────

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Contract;
const target = resolveRunner();

if (!target) {
  // Loud on purpose: a silently-skipped guard is a guard that has stopped
  // existing. This prints on every ordinary `pnpm test` run without a stack.
  console.warn(
    '[schema-contract] SKIPPED — no local Supabase reachable. The labre_mcp schema ' +
      'contract (ARCH-26) was NOT verified against a database. Start the labre local ' +
      `stack, or set SUPABASE_DB_URL (loopback) / LABRE_MCP_SCHEMA_DB_CONTAINER ` +
      `(default ${DEFAULT_CONTAINER}).`,
  );
}

// Needs no database: it plants drift against the contract's own text. It runs
// on every `pnpm test`, stack or not — a guard nobody has seen fail is a guard
// nobody knows works, and this is the half that can always be seen.
describe('labre_mcp schema contract — the diff engine', () => {
  it('names a disabled RLS, a dropped column and a widened grant', () => {
    const planted: LiveShape = {
      schemaUsage: contract.schemaUsage,
      tables: contract.tables.map((t, i) =>
        i === 0
          ? { ...t, rls: false, columns: t.columns.slice(1), grants: [...t.grants, 'anon:SELECT'] }
          : t,
      ),
      functions: contract.functions,
    };
    const violations = diffContract(contract, planted);
    const first = contract.tables[0]!;
    assert.ok(
      violations.some(v => v.includes('RLS is OFF')),
      `RLS drift not reported: ${violations.join(' | ')}`,
    );
    assert.ok(
      violations.some(v => v.includes(`MISSING \`${first.columns[0]!.name}\``)),
      `dropped column not reported: ${violations.join(' | ')}`,
    );
    assert.ok(
      violations.some(v => v.includes('UNEXPECTED `anon:SELECT`')),
      `widened grant not reported: ${violations.join(' | ')}`,
    );
  });

  it('reports nothing when the live shape IS the contract', () => {
    const identical: LiveShape = {
      schemaUsage: contract.schemaUsage,
      tables: contract.tables,
      functions: contract.functions,
    };
    assert.deepEqual(diffContract(contract, identical), []);
  });
});

describe(
  'labre_mcp schema contract — against the live database (ARCH-26)',
  { skip: target ? false : 'no local Supabase stack reachable' },
  () => {
    it('the live schema matches labre-mcp.contract.json', () => {
      const live = JSON.parse(target!.run(INTROSPECT_SQL)) as LiveShape;
      const violations = diffContract(contract, live);
      assert.deepEqual(
        violations,
        [],
        `The \`labre_mcp\` schema has DRIFTED from the contract this repository codes ` +
          `against (introspected via ${target!.how}).\n\n` +
          violations.map(v => `  • ${v}`).join('\n') +
          `\n\nARCH-26: the migrations live in the labre repo ` +
          `(supabase/migrations/), the contract lives here. A change to one without ` +
          `the other is exactly what this test exists to catch. Fix the migration, or ` +
          `update src/lib/schema-contract/labre-mcp.contract.json — never neither.`,
      );
    });
  },
);
