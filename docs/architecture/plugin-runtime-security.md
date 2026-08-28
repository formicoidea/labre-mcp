# Plugin runtime — security model

> **Companion to [ARCH-29](decisions.md#arch-29--plugin-runtime-security-model-data-only-is-load-bearing).**
> Status ✅ **Arbitrated 2026-08-28 — option (a) retained: richer DATA-ONLY
> bundles, no executable plugin runtime.** The § 7 questions are answered in
> ARCH-29. This document holds the evidence, the threat model and the option
> analysis; the evidence and the threat model are **current state**, options (b)
> and (c) are the **refused branches**, kept because the switching criterion may
> revive them. Not a single byte of executable-plugin code exists, and under (a)
> none is to be written.

---

## 1. What exists today, verified

### 1.1 A bundle is data, and the code says so in its first paragraph

`src/schemas/strategy-bundle.schema.mts:3` opens with the rule itself:

> "A strategy bundle is a DATA-ONLY package (no executable code)"

A bundle is four kinds of file and nothing else
(`src/schemas/strategy-bundle.schema.mts:6-10`):

```
<bundle-root>/
  manifest.json                              ← StrategyBundleManifestSchema
  recipe.json                                ← exactly one recipe in v0
  prompts/<strategyId>/<name>.system.md      ← optional, always split pairs
  prompts/<strategyId>/<name>.user.md
```

The manifest carries six fields and no seventh —
`schemaVersion`, `slug`, `version`, `description`, `permissions`, `prompts` —
and the schema is `.strict()` (`src/schemas/strategy-bundle.schema.mts:41-59`),
so an unknown key is a load failure rather than a forward-compatible extension
point. There is no `main`, no `entry`, no `module`, no `scripts`.

The loader reaches the content through exactly two verbs:
`JSON.parse` (`src/lib/bundles/bundle-loader.mts:81`) and a string read for the
prompt pairs (`src/lib/bundles/bundle-loader.mts:96-107`). No `import()`, no
`Function`, no `eval`, no `vm`, no `require`. A bundle cannot execute because
nothing in the path is capable of executing it.

**What a bundle therefore composes:** shipped primitives. Its `recipe.json` is
validated against the shipped `RecipeSchema`, which enforces the 5-segment
methodId grammar on every step (`src/lib/bundles/bundle-loader.mts:125-130`), so
every step of every bundle recipe names a strategy **this binary already
contains**. Its prompt overrides must each shadow a *shipped* template prompt
(`assertBundlePromptsOverridable`, `src/lib/bundles/bundle-loader.mts:200` and
`src/lib/bundles/supabase-bundle-source.mts:268`) — a bundle cannot introduce a
prompt for a strategy that does not exist. And a bundle recipe may never shadow
a shipped recipe: the collision is rejected at registration
(`src/lib/bundles/bundle-loader.mts:196-206`).

So today a bundle can **recombine** and **reword**. It cannot **add a
capability**, and it cannot **replace** one.

### 1.2 The seal, and who may write behind it

The transport of a bundle is already hardened well past what a data payload
strictly needs:

- **Zero daemon credential.** The daemon holds no Supabase key of its own and
  never the service-role key; bundles are fetched with the **caller's** JWT plus
  the public anon key, on a client built per refresh and discarded when the
  refresh settles (`src/lib/bundles/supabase-bundle-source.mts:107-121`,
  `:273-284`). This is a load-bearing invariant of the whole daemon
  ([mcp-data-store-position.md](mcp-data-store-position.md)).
- **Integrity seal.** Every downloaded file is sha256-re-verified against the
  row's `files` digest list; one mismatch rejects the **whole** bundle
  (`src/lib/bundles/supabase-bundle-source.mts:235-246`). The row is
  `service_role`-write-only while `authenticated` gets `SELECT` alone
  (`src/lib/schema-contract/labre-mcp.contract.json`, table `strategy_bundles`,
  `grants`), so a bucket compromise on its own cannot inject a bundle — the
  digests would not match.
- **Untrusted-input posture.** Rows are zod-validated, the row's own `manifest`
  jsonb copy is deliberately ignored in favour of the sealed downloaded
  `manifest.json` (`src/lib/bundles/supabase-bundle-source.mts:66-77`), and a
  row whose slug disagrees with the sealed manifest is rejected
  (`:259-263`).
- **Per-bundle isolation and an atomic swap.** A bad bundle degrades alone
  (`Promise.allSettled`, `:317-333`); `resetBundleRecipes()` + re-registration
  run with no `await` between them so no concurrent lookup sees a half-swapped
  set (`:338-347`).

Two things are worth naming precisely because a plugin runtime would inherit
them and they are weaker than they look:

- **`manifest.permissions` is decor.** The enum exists —
  `['llm', 'bigquery', 'network', 'render']`
  (`src/schemas/strategy-bundle.schema.mts:39`) — and the codebase reads it in
  **exactly one place**, to check that a bundle declaring prompts also declares
  `llm` (`src/lib/bundles/bundle-loader.mts:143-147`). Nothing enforces
  `network`. Nothing enforces `bigquery`. Today that is harmless: data cannot
  make a network call. Under any executable option it becomes a field that
  *looks* like a capability gate and is not one. Fixing it is part of the price
  of (b) or (c), not a freebie.
- **The seal proves integrity, not provenance.** sha256 says "these are the
  bytes the admin API hashed". It does not say who authored them, and there is
  no signature anywhere in the chain. The trust anchor is the admin API's
  `requireAdmin()` + service-role write door
  ([remote-admin-contracts.md](../technical/remote-admin-contracts.md),
  responsibility matrix), i.e. **an authorisation boundary in another
  repository**, not a cryptographic identity attached to the artefact.

### 1.3 The registries are hard-coded, in one file each

`buildStrategyRegistry()` (`src/frameworks/registry-boot.mts:39-50`) is six
lines: five framework register calls plus the mocks, behind one env var.

```ts
export function buildStrategyRegistry(): StrategyRegistry<BaseStrategy> {
  const registry = new StrategyRegistry<BaseStrategy>();
  registerEvolutionStrategies(registry);
  registerChainStrategies(registry);
  registerIterationStrategies(registry);
  registerCommonStrategies(registry);
  registerRenderStrategies(registry);
  if (process.env.LABRE_DISABLE_MOCKS !== "1") {
    registerMocks(registry);
  }
  return registry;
}
```

The catalogue is **86 strategies: 25 real, 61 mocks**
([roadmap.md](roadmap.md), "État courant en une ligne" — the CH-26 backlog says
66, the tree says 61; `find src/frameworks -name '*.mock-strategy.mts' | wc -l`
returns **61**, and `mocks-registry.mts` has **61** `registry.register` calls).
`mocks-registry.mts` is 61 imports and 61 registrations, one line each, by hand
(`src/frameworks/mocks-registry.mts:15-79` and `:82-142`).

**A finding that decides more than it looks.** The 61 mocks are not 61 programs.
They are 61 copies of one program. Every single one is a 44-line file whose
`evaluate()` body is byte-identical modulo the methodId:

```ts
const capturedAt = new Date().toISOString();
return {
  signals:   [{ name: 'mock', value: true, source: 'computed', capturedAt }],
  reasoning: [],
  insights:  [{ text: `mock strategy for ${METHOD_ID}`, by: METHOD_ID, type: 'other' }],
  result:    { mock: true, methodId: METHOD_ID },
};
```

All 61 files match that `result` line exactly. There is no branching, no input
read (`_input` is ignored in all of them), no I/O. **The 61 mocks are 100 %
expressible as data** — a methodId plus a fixture payload. Whatever else a hot
plugin runtime is for, it is not for them.

The registry itself already has the two hooks a runtime would need:
`register()` throws on a duplicate methodId
(`src/core/registry/strategy-registry.mts:44-46`) and `get()` is *the* single
resolution point of the kernel — both `runCommand` and the recipe runner go
through it — where the CH-18 `disabled` guard refuses a strategy with its
declared reason (`src/core/registry/strategy-registry.mts:58-76`). A plugin
whose activation must be revocable at runtime has a place to be refused
already; it does not need a new mechanism, it needs a writer for the existing
one.

### 1.4 What replay and traceability actually record today

**I3 (replay).** CH-12 injected the runner's clock: `RunClock` gives `now()` and
`newId()`, both defaulted to the real ones, and it drives every timestamp,
every `durationMs` and the `recipeRunId`
(`src/core/recipe/recipe-runner.mts:36-51`, `:150-151`). The invariant is pinned
byte-for-byte by `recipe-determinism.test.mts`
([recipes.md](recipes.md) § "Replayable runs (invariant I3)").

Its documented hole is exactly the one CH-26 walks into: *"A strategy that
timestamps its own signals (`capturedAt`) keeps its own clock — out of the
runner's reach"*. That is not hypothetical. `new Date()` appears **61 times in
the mocks** (once each) and **26 times in the real framework code**. Byte-stable
replay therefore already depends on which strategies are in play — and under a
plugin runtime, *which strategies are in play* becomes a runtime property of the
deployment rather than a property of the binary.

**I5 (traceability).** Two records exist and **neither carries code
provenance**:

- `PipelineEvent` (`src/core/bus/event.schema.mts:8-20`) has four phases —
  `step-start`, `step-end`, `step-error`, `run-end`. There is no lifecycle phase
  for anything but a step. Nothing on the bus can say "a plugin was loaded".
- `ArtifactBody` (`src/core/persistence/artifact-writer.mts:16-28`) records
  `recipeRunId`, `sessionId`, `domain`, `projectId`, `projectRoot`, `startedAt`,
  `completedAt`, `events`, `ast`. **No version. No hash. No plugin list.**

So an artefact written today does not identify the code that produced it. As
long as the code is the binary, the artefact's provenance is implicit in the
npm version of the daemon and the omission is survivable. The moment a plugin
can change what `wardley:map:value-chain:generate:default` *does* without the
daemon version moving, the artefact becomes **unattributable** — and I3 dies
quietly, because a replay that produces different output has no way to notice it
ran different code. This is the mechanical reason garde (b) of the C4
arbitration is not bureaucracy.

### 1.5 Two trust boundaries, not one

The threat model is asymmetric and the asymmetry is the whole reason this ADR
exists:

| Delivery | Where it runs | Trust boundary today | Blast radius of arbitrary code |
| --- | --- | --- | --- |
| **stdio** (`src/mcp/labre-stdio.mts`) | the end user's machine, spawned by their agent | *the spawning process* ([remote-admin-contracts.md](../technical/remote-admin-contracts.md)) | the user's home directory, their `~/.labre-mcp/`, their env, their network egress, whatever their agent's process can reach |
| **HTTP daemon** (`src/mcp/labre-daemon.mts`, :6767) | a shared host, many callers | JWKS-verified Supabase JWT, one process per instance | **every concurrent caller's** verified bearer token, every in-flight AST, every artefact path, every LLM provider key in the process env |
| **lib mode** (`src/index.mts`, ARCH-27) | inside a host application — potentially labre's own | the host | whatever the host has |

The HTTP row is the sharp one. ARCH-27's third cut deliberately strips the auth
nature at `dispatch` so that *no bearer reaches a strategy* — "it is not in the
object they receive". That protection is a **type and shape** protection: it
holds because a strategy is code we wrote, that reads its argument. A strategy
loaded from a plugin is code we did **not** write, running in the same process,
with the same heap. `AuthContext` objects for other in-flight requests are
reachable from it; so is `process.env`. ARCH-27's guarantee is real and
valuable, and it is **not** a defence against in-process arbitrary code. Saying
otherwise would be the most expensive mistake available here.

---

## 2. What DATA-ONLY protects, named threat by threat

The rule is worth exactly the four things it currently makes impossible. Each
is listed with what it costs to re-establish once code can run.

**T1 — Arbitrary execution on the daemon user's machine (stdio).**
Today a hostile bundle row is a JSON parse failure. Under an executable runtime
it is `require('child_process')` on the machine of whoever runs `labre-mcp`
locally — including a developer with `.env.local`, SSH keys and a git credential
helper. There is no privilege boundary between a stdio daemon and its user;
the trust boundary *is* the spawning process. Re-establishing protection means a
real sandbox, not a code review.

**T2 — Exfiltration of the calling user's JWT (HTTP daemon).**
The daemon deliberately holds no privileged credential of its own, which means
the most valuable secret in the process is **the caller's bearer** — the very
token the bundle source uses to read Supabase under RLS
(`src/lib/bundles/supabase-bundle-source.mts:120`). ARCH-27 keeps it out of the
strategy's *argument*; it cannot keep it out of the strategy's *address space*.
One plugin, one `fetch` to an attacker host, and the daemon has become a token
laundering service for every concurrent caller. Note the recursion:
the token that authorises loading the plugin is the token the plugin steals.

**T3 — Artefact corruption.**
`writeArtifact` writes to `~/.labre-mcp/runs/<projectId>/` or to
`context.artifactDir` (`src/core/persistence/artifact-writer.mts:44-48`) — real
files, on a real filesystem, in a process that today only ever writes there. In-
process code can write anywhere the process can, and can also rewrite artefacts
of *past* runs. Because artefacts are the evidentiary base of I5 and the input
of the future analytical layer (ARCH-12, "V2 DuckDB reads these files
directly"), an attacker who can edit them retroactively does not merely corrupt
data — they corrupt the record that would show the corruption.

**T4 — Telemetry spoofing.**
The PostHog listener (`src/core/listeners/posthog-telemetry-listener.mts`) and
the bus it subscribes to are in-process. A plugin can emit `PipelineEvent`s the
runner never produced, attribute cost and quality to a variant that never ran,
and poison the A/B experiment store that
[mcp-data-store-position.md](mcp-data-store-position.md) makes the *reason* for
having no experiments database. Under a bundle-as-data model this is impossible
because a bundle has no way to reach the bus at all.

**The honest summary.** DATA-ONLY is not one control. It is a *categorical*
argument: the payload is inert, therefore no control is needed. Every executable
option replaces one categorical argument with a set of controls that must each
be built, tested and kept green. That is the trade the human is being asked to
price — not "is a plugin runtime nice", but "are we buying a permanent
security-controls maintenance obligation, and in exchange for what".

---

## 3. Options

### (a) Extended status quo — richer DATA-ONLY bundles

Push data as far as it goes. Concretely, the manifest gains kinds beyond
"recipe + prompts": declarative **fixture strategies** (methodId → constant
result payload — which, per § 1.3, covers all 61 mocks exactly), declarative
**config strategies** (an axis definition, a doctrine list, a wiki URL table —
several existing mocks are literally that), **recipe sets** rather than exactly
one recipe, and richer prompt layering. The kernel gains one new *shipped*
strategy class that interprets a fixture declaration; the plugin surface gains
nothing executable.

- **Attack surface added:** essentially none. The parser widens; the loader
  still never executes. The existing sha256 seal, RLS write door and per-bundle
  isolation continue to hold *by construction* rather than by vigilance.
- **Cost:** low and mostly one-off — a wider manifest schema, one fixture
  strategy, a migration of 61 near-identical files into 61 JSON entries. Note
  it *also* closes an I3 leak for free: a fixture's `capturedAt` comes from the
  injected clock instead of 61 hand-rolled `new Date()` calls.
- **What it forbids:** genuinely new behaviour. A third party cannot ship a
  parser for a format we do not parse, an estimator with real arithmetic, or a
  renderer we do not have. Every bundle stays a recombination of shipped
  primitives. **A "framework plugin" under (a) is a framework whose logic we
  already shipped** — which is fine for EDGY-as-a-set-of-recipes and false for
  EDGY-as-a-set-of-computations.
- **Where it breaks:** the first strategy that must *compute* something we did
  not anticipate. Not the first strategy that must *say* something new.

### (b) Minimal in-house loader

Signed, pinned JS modules loaded by dynamic `import()`, resolving their
capabilities from an injected allowlist rather than from the ambient runtime:
no direct `fetch`, no `node:fs`, no `node:child_process` — an LLM call, an
artefact read, a render go through a capability object the kernel hands the
plugin at activation. Version pinned by content hash; the hash is the identity.

- **Attack surface added:** the honest amount, which is *large*. An allowlist of
  imports is not a sandbox: a dynamically imported ES module shares the realm,
  and it reaches `globalThis`, `process`, `process.env`, and every live object
  graph in the process — including, per T2, other requests' `AuthContext`. A
  static import allowlist is defeated by `globalThis.process.binding`,
  `constructor.constructor('return process')()`, and a dozen other paths.
  **Option (b) buys supply-chain control (who authored this, has it changed) and
  buys essentially no runtime containment.** It must be stated in exactly those
  terms or it will be mis-sold.
- **Cost:** high and recurring. A signing key and its custody (nothing in either
  repo signs anything today), a verification path, a revocation story, a pinning
  registry, activation events, the `permissions` enum promoted from decor to an
  enforced gate, plus the permanent obligation to keep the escape-hatch review
  current against new Node APIs.
- **What it forbids:** an unsigned plugin, an unpinned version, and — if
  combined with the sandbox axis of § 4 — direct ambient I/O. On its own it
  forbids *unknown provenance*, not *bad behaviour*.
- **Where it fits:** if plugins are authored **only by us** and the requirement
  is really "ship a framework without a daemon release", (b) is proportionate,
  because the trust decision has already been made out-of-band and what is
  needed is integrity, not containment.

### (c) Cordis

[Cordis](https://github.com/cordiverse/cordis) is a TypeScript "meta-framework
of spatiotemporal composability": a `Context` that is simultaneously a DI scope
and a lifecycle manager, demand-driven injection (a plugin declares the services
it needs and does not run until they exist, so load order is expressed as
requirements rather than boot sequencing), effect tracking so that disposing a
context unwinds everything the plugin registered — timers, listeners, clients —
and hot module replacement.

**What it gives us that is genuinely relevant:** the *lifecycle* half of a hot
plugin runtime, done well. Activation/deactivation, ordered dependency
resolution, and clean unregistration on unload — that last one is exactly the
problem `StrategyRegistry` does not solve today (`register()` throws on a
duplicate and there is no `unregister()`; the only removal path is the atomic
`resetBundleRecipes()` swap on the *recipe* side, and nothing equivalent on the
strategy side).

**What it does not give us, checked and stated plainly:** any security control
whatsoever. Its own README and reference documentation describe Context,
plugin, service, inject and dispose/effect, and contain **no mention of
sandboxing, isolation, permissions, signing, integrity or trust boundaries**. In
Cordis a plugin is ordinary Node code loaded into the host process with full
host privileges. It is a composition framework, **not a bac à sable** — and it
does not claim to be one; the claim would be ours if we made it. Two further
facts belong in the decision: the project states its **API is not yet stable and
may change without notice**, and adopting it means the kernel's composition root
becomes a third-party `Context` rather than the six-line function at
`src/frameworks/registry-boot.mts:39` — a large architectural intake for a
repository whose entire delivery surface is six MCP tools.

**Verdict on (c):** Cordis solves a problem we do not have yet (complex
overlapping plugin lifetimes) and solves none of the problem we do have (running
untrusted code safely). Choosing it does not remove the need for options (b)'s
signing/pinning work or § 4's containment work — it **adds** a dependency on top
of them.

### Comparison

| | (a) rich data | (b) minimal loader | (c) Cordis |
| --- | --- | --- | --- |
| New attack surface | ~none | large (in-realm code) | large (in-realm code) + a fast-moving dependency |
| Covers the 61 mocks | **yes, entirely** | yes | yes |
| Allows genuinely new computation | **no** | yes | yes |
| Provenance / integrity | inherits today's sha256 seal | must be built (signing, pinning) | not provided; must be built anyway |
| Runtime containment | by construction | none without § 4 | none without § 4 |
| Unload / revoke | n/a (nothing loaded) | must be built | **provided** (effect tracking) |
| Recurring cost | low | high | high + upstream API churn |

---

## 4. The orthogonal axis: containment

Containment is **not a fourth option**. It is a property that (b) and (c) both
need and neither provides, and it can be added to either.

- **`node:worker_threads`** — a worker is a separate JS realm with its own heap,
  so it does *not* share `AuthContext` objects by reference, and messages cross
  by structured clone. That kills the most direct form of T2. It does **not**
  restrict what the worker's own code may do: a worker still has `fs`, `net` and
  `child_process`. Worker isolation alone converts "reads another caller's
  token out of the heap" into "opens its own socket and exfiltrates whatever it
  was given" — a real improvement, not a solution.
- **Node's permission model** (`--permission`, Node 20+, still experimental) —
  restricts filesystem and child-process access, but it is **process-wide**, set
  at launch. It cannot express "the kernel may write artefacts, the plugin may
  not", which is precisely the distinction T3 needs. Useful for hardening the
  stdio deployment as a whole; not a per-plugin control.
- **V8 isolates / `isolated-vm`** — the only option on this list that is an
  actual security boundary for in-process untrusted code: a separate isolate
  with no ambient host access, where every capability must be explicitly
  bridged. It is also the most invasive: a native addon, a serialisation cost on
  every call across the boundary, no shared object graph (so the plugin cannot
  simply be handed an AST), and a bridge that is itself security-critical code
  we would own.
- **Out-of-process / WASM** — strongest boundary, highest cost, and it changes
  what a strategy *is* (no shared AST, an IPC contract instead of a method
  call).

The decision rule worth writing down: **the containment requirement is set by
who may author a plugin, not by what a plugin does.** First-party-only plugins
need integrity (b), not containment. Third-party plugins need containment, and
then the honest minimum is an isolate or a process — worker threads and import
allowlists are hardening, not boundaries, and must not be described as more.

---

## 5. The two non-negotiable guards, as testable requirements

From the human's C4 arbitration (2026-08-25), restated so a test can fail on
each.

### G1 — Every activation is a traced event with a pinned version

**R1.1** `PipelineEvent.phase` gains `plugin-activated` (and `plugin-rejected`),
or an equivalent lifecycle event carries `{ id, version, contentHash }`.
`src/core/bus/event.schema.mts:14` is a `z.enum` of four step phases today;
extending it is a schema-version decision, not an afterthought.
*Test:* activating a plugin with the bus stubbed emits exactly one
`plugin-activated` whose `contentHash` equals the sha256 of the activated bytes.

**R1.2** `ArtifactBody` gains a `codeProvenance` block: the daemon version plus,
for every methodId reachable during the run, the plugin id and content hash that
supplied it (`{}` when everything came from the binary).
`src/core/persistence/artifact-writer.mts:16-28` records none of this today.
*Test:* an artefact from a run using a plugin names that plugin's hash; an
artefact from a binary-only run carries an empty, **present** block — absence
must be an explicit "nothing", never a missing key.

**R1.3** Replay refuses on a provenance mismatch. Replaying an artefact whose
`codeProvenance` names a plugin hash the current process does not have loaded
**fails loudly** rather than replaying against different code.
*Test:* record an artefact under plugin hash `A`, load hash `B`, replay → error
naming both hashes. This is the requirement that makes I3 survive CH-26; without
it a replay silently answers a different question.

**R1.4** No `capturedAt` from a plugin's own `new Date()`. A plugin receives the
run clock; the seam already exists (`RunClock`,
`src/core/recipe/recipe-runner.mts:36-51`) and the documented hole
([recipes.md](recipes.md) § I3) is closed for plugins by contract rather than by
convention. *Test:* two runs of a plugin-supplied strategy under a fixed clock
produce byte-identical artefacts — the same shape as
`recipe-determinism.test.mts`.

### G2 — The security model is written before the first executable byte

**R2.1** No module under `src/` gains `import()`, `Function`, `vm`, `eval` or a
native isolate binding on a path reachable from a plugin.
*Amended 2026-08-28:* this requirement was worded as "ARCH-29 is arbitrated
(status moves off 🔴) before…". The arbitration has now landed and retained
**(a)**, so that wording would satisfy itself and lift the guard — the opposite
of what (a) decides. Under (a) the rule is unconditional; it lapses only if a
later arbitration retains an executable option and records it in ARCH-29 first.
*Guard:* a mechanical rule in the ARCH-27 boundary checker family
(`scripts/check-import-boundaries.mts`) — a grep-level gate is enough and is
cheap; the point is that it fails in CI, not that it is clever.

**R2.2** `manifest.permissions` stops being decor. Whatever option is retained,
either the enum is enforced at the capability seam or the field is removed. A
declared-but-unenforced permission on an executable payload is worse than no
field: it invites a reviewer to believe a gate exists.
*Test:* a plugin declaring no `network` and attempting egress is refused (option
b/c), or the field no longer exists (option a).

**R2.3** Activation is revocable at the existing resolution point. The CH-18
`disabled` guard (`src/core/registry/strategy-registry.mts:58-76`) is the single
place both `runCommand` and the runner resolve a strategy; a revoked plugin's
methodIds resolve to a refusal carrying the reason, not to a stale class.
*Test:* revoke, then `get()` → throws with the revocation reason.

---

## 6. Migration path for the hard-coded registries

Only relevant if the human retains an executable option; under (a) steps 1–2
are the whole job.

1. **Make the registry writable in both directions.** `StrategyRegistry` gains a
   scoped registration (an owner tag per entry) and an `unregister`/`revoke` for
   that owner, reusing the `disabled` map as the refusal channel so there is one
   resolution point, not two. `register()`'s duplicate-throw
   (`src/core/registry/strategy-registry.mts:44-46`) becomes owner-aware: a
   plugin may never take a methodId the binary already owns.
2. **Move the 61 mocks out of code.** They are 61 identical files; they become
   61 fixture declarations plus one shipped fixture strategy.
   `mocks-registry.mts` and `LABRE_DISABLE_MOCKS` disappear together — the flag
   is replaced by simply not loading the fixture set. This is worth doing under
   *every* option, and it is the tranche with the best cost/benefit ratio in
   CH-26.
3. **Frameworks last, one framework at a time.** `registry-boot.mts` keeps its
   five calls until a *real* framework — not a mock — has been shipped as a
   plugin end to end, with G1's provenance and replay tests green. A framework
   that only recombines shipped primitives should ship under (a) and never
   become executable at all.
4. **The façade is where it plugs.** Per ARCH-27, a plugin runtime fills a
   kernel-owned registry composed by a delivery; it touches neither
   `src/core/transport` boundaries nor `src/mcp/`. Whatever is chosen must
   respect `pnpm check:boundaries` with an **empty** baseline — a new baseline
   entry is a request to reopen ARCH-27.

---

## 7. Open questions the human has to answer

These are the inputs the recommendation depends on. They are not rhetorical.

1. **Who may author a plugin?** First-party only, or third parties? This single
   answer sets the containment requirement (§ 4) and therefore most of the cost.
2. **Which deployment must support hot plugins?** If only the HTTP daemon, the
   stdio threat T1 is out of scope and the problem shrinks. If stdio too, we are
   shipping a code-execution vector to end-user machines.
3. **What does "framework plugin" mean for EDGY / Cynefin / BPMN?** A set of
   recipes and prompts over primitives we already have (→ option a suffices), or
   genuinely new computation (→ b/c required)? Naming one concrete strategy that
   (a) *cannot* express would settle this faster than any further analysis.
4. **Is a signing key acceptable operationally?** Nothing in either repository
   signs anything today. Key custody, rotation and revocation are ongoing
   obligations, not a one-off setup.
