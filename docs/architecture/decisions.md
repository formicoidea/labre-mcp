# Architecture Decision Records — labre-mcp

This document captures the architectural decisions made during the migration from `WardleyAssistant` (a Wardley-specific MCP server) to `labre-mcp` (a generic platform for orchestrating practice frameworks, with Wardley as its first framework).

Each decision is identified `ARCH-NN`, immutable once recorded. Supersession is marked explicitly with a status update; the original is never edited.

Format: ADR (Architecture Decision Record).

---

## ARCH-01 — Six tools compose the Wardley framework

**Status:** Superseded by AST-schema v0.1.0 — the Wardley framework now decomposes into five tools (`map`, `doctrine`, `climate`, `gameplay`, `iteration`). `chain` becomes a subdomain of `map`, `evolution` becomes a subdomain of `map:climate`, `cycle` is renamed `iteration`. See [ast-schema.md](ast-schema.md).

**Context:** Simon Wardley's full strategic study cycle includes more than the value chain map. Distinct deliverables exist for climates (climatic patterns), doctrines (universal organising principles), gameplays (strategic moves), and the strategy cycle that orchestrates the others. A sixth concept, evolution, is dual-natured (both a chain element and a climatic pattern) and warrants its own tool.

**Decision:** The Wardley framework decomposes into six tools: `chain`, `evolution`, `climate`, `doctrine`, `gameplay`, `cycle`. Each tool has its own AST and its own strategy registries.

**Consequences:** The naming hierarchy carries a tool segment (ARCH-03). Each tool is independently extensible. `cycle` is a meta-tool that orchestrates the other five.

---

## ARCH-02 — V1 scope is `chain` + `evolution`

**Status:** Superseded by AST-schema v0.1.0 — v0.1.0 scope covers the Wardley domain exhaustively (5 tools) plus the `render` domain (OWM and image) plus the transverse `common` domain. See [ast-schema.md](ast-schema.md).

**Context:** The current codebase covers most of `chain` and all of `evolution`. The four other tools (`climate`, `doctrine`, `gameplay`, `cycle`) are V2+. Trying to scaffold all six at once multiplies cost without proportionate validation.

**Decision:** Migrate `chain` and `evolution` to the new architecture in V1. Defer the four others.

**Consequences:** Kernel is designed generically enough that adding the four tools later requires no kernel changes — only new framework code.

---

## ARCH-03 — Strategy identity uses 5 segments

**Status:** Amended by AST-schema v0.1.0 — arity preserved (5 mandatory segments), but the grammar becomes `{domain}:{tool}:{sous-domaine}:{command}:{strategie}` (segments 3 and 4 are swapped vs the original). `default` is a canonical strategy name (always present at segment 5). SemVer triplet `@x.y.z` adopted (see ARCH-20 amendment). See [ast-schema.md](ast-schema.md).

**Context:** The current naming `{phase}:{domain}:{strategy}` (e.g. `write:capacity:s-curve`) cannot disambiguate between frameworks or between tools within a framework.

**Decision:** Strategy methodIds follow the pattern `{framework}:{tool}:{command}:{subdomain}:{strategy}[@version]`. All five segments mandatory; `@version` optional (defaults to `@latest`).

**Examples:**
- `wardley:chain:write:capacity:s-curve`
- `wardley:evolution:read:component:identify-capability`
- `wardley:chain:emit:owm`
- `common:write:layout:place-labels` (cross-framework — uses `common` as framework)

**Consequences:** Existing methodIds must be renamed (CP4, CP5). The `framework` segment supports multiple frameworks and a special `common` namespace for cross-framework strategies.

---

## ARCH-04 — Four commands: read, write, quality, emit

**Status:** Superseded by AST-schema v0.1.0 — the fixed four-command vocabulary is replaced by an open command vocabulary (`generate`, `parse`, `emit`, `audit`, `identify`, `estimate`, `explain`, `guide`, `next-step`, `recommend`, `update`, `classify`, etc.). The `update` command is now allowed as a standalone command operating on the métier JSON (e.g. `wardley:map:output:update:default` is the canonical write-gateway). Listeners are no longer implicit event-bus subscribers — they are explicitly declared in `recipe.listeners[step]`. See [ast-schema.md](ast-schema.md).

**Context:** The current code has `read/` and `write/` namespaces but no formal place for verification or serialisation logic. Layout placement is currently a function, not a strategy.

**Decision:** Four canonical commands:
- `read` — parse external input into AST (parser, classifier, identifier)
- `write` — produce or enrich AST content (estimator, generator, layout placer — placement is a form of writing)
- `quality` — validate, score, detect cross-step patterns (replaces "verify"; covers more)
- `emit` — serialise AST to external format (OWM, Mermaid, JSON-LD, markdown report)

No `update` command — it is composition (read + write + emit), expressible as a recipe.

**Consequences:** Existing `verify-layout` becomes `quality:layout:*`. `place-labels` becomes `write:layout:place-labels`. New `emit:*` registries replace ad-hoc emit functions.

---

## ARCH-05 — WardleyAPI render schema is snapshotted

**Status:** Deferred — the snapshot files (`schema-snapshot.mts`, `wardley-chain-ast.mts`) were drafted in V1 but never wired into any runtime path; they were removed in the post-v0.1.0 cleanup. The renderer schema (`wardley-map.schema.json`) remains the norm de communication per [ast-schema.md](ast-schema.md) § 2.0; an internal AST will be recreated when a concrete consumer needs strongly-typed `Component`/`Relation` shapes beyond what the renderer schema provides.

**Context:** The `WardleyAPI/packages/render` package already defines a comprehensive Zod schema for the Wardley map data model (Component, Relation, EvolvesTo, Position, etc.). Re-implementing this in labre-mcp would guarantee divergence.

**Decision:** Copy the data-layer types from `WardleyAPI/packages/render/src/schema.ts` into `src/frameworks/wardley/chain/ast/schema-snapshot.mts`. Render-specific types (RenderConfig, theme, coordinate space) are not snapshotted — labre-mcp's chain AST is a data model, not a rendering model. Divergence over time is acceptable; if a shared package becomes valuable in V2+, extract then.

**Consequences:** The snapshot is in `src/frameworks/wardley/chain/ast/schema-snapshot.mts`. `WardleyChainAST` extends it with labre-mcp-specific annotations (e.g. `EvolutionAnnotation` per ARCH-22).

---

## ARCH-06 — Recipes are tool-scoped

**Status:** Amended by AST-schema v0.1.0 — recipes may now traverse multiple tools within a single domain (e.g. a recipe combining `wardley:iteration:purpose:generate:default` + `wardley:map:value-chain:generate:top-down` + `wardley:map:value-chain:select-by-type:component`). Cross-domain orchestration still happens at the skill level. See [ast-schema.md](ast-schema.md) § 1.3.

**Context:** Cross-tool data flows could be expressed as multi-tool recipes or as skill-level orchestration. Mixed scoping makes recipe semantics hard.

**Decision:** A recipe operates on a single tool's AST. Cross-tool flows (e.g. chain → evolution → chain) happen at the skill level, where one skill calls multiple recipes in sequence and stitches results.

**Consequences:** Recipes stay simple and predictable. Skills become the cross-tool orchestrators. The `cycle` tool (V2+) likely needs special handling for its meta-orchestration role.

---

## ARCH-07 — Recipes are not parameterisable

**Status:** Accepted

**Context:** The current `evaluateMap` accepts a `strategy: 'auto' | 'report'` parameter that switches behaviour. Generalising "recipes with parameters" leads to recipes-as-config-as-program.

**Decision:** Recipes are not parameterisable. Variation is expressed by attaching different listener strategies to the same base recipe — listeners observe the event bus and inject insights or alternative analyses without modifying the main pipeline.

**Consequences:** `evaluateMap` (auto) is one recipe. To get a "report" view, attach a multi-strategy comparison listener to the same recipe. The asymmetry is conceptually cleaner: recipes describe the canonical flow; listeners are the pluggable lens.

---

## ARCH-08 — Recipes follow a shipped + override pattern

**Status:** Accepted

**Context:** Canonical recipes ship with labre-mcp; power users may want their own recipes per project.

**Decision:** Recipes are loaded from two locations and merged at runtime:
1. **Shipped:** `<labre-mcp-repo>/recipes/<framework>/<tool>/<recipe-name>.recipe.json`
2. **User custom:** `<context.projectRoot>/recipes/<framework>/<tool>/<recipe-name>.recipe.json`

User files take precedence by name. Same merge model applies to `llm.config.json`. **Does not** apply to `prompts/*` (strategy-internal, see ARCH-21).

**Consequences:** Recipe loader uses `lodash.merge` for deep merge. Project root must be in `RequestContext` (per ARCH-15).

---

## ARCH-09 — `common:` is reserved for cross-framework

**Status:** Accepted

**Context:** Some strategies are universal across frameworks (e.g. detecting overlap in any 2D layout). They need a namespace.

**Decision:** Use `common:` as the framework segment for cross-framework strategies. Do not create `wardley:common:` for cross-tool-within-Wardley strategies until a real need emerges — premature abstraction.

**Consequences:** `common:write:layout:overlap-detection` valid; `wardley:common:*` not in use V1.

---

## ARCH-10 — Event bus is RxJS in-process, async-by-default

**Status:** Amended by AST-schema v0.1.0 — the event bus persists as the underlying transport, but listeners are no longer implicit subscribers. Each recipe explicitly declares its listeners per step via `recipe.listeners[stepName]: methodId[]` (cf. § 1.3). Core listeners (degradation tracker, artifact writer, notification emitter) remain non-disablable and continue to subscribe implicitly. See [ast-schema.md](ast-schema.md) § 1.3.

**Context:** Cross-step analysis (a listener observing N strategy outputs to flag suspicious distributions) requires a pub/sub primitive. Distributed brokers (Kafka, Flink) are 4 orders of magnitude over-engineered for our scale.

**Decision:** In-process event bus backed by RxJS Subject. Async-by-default (modules emit and listen; no commands flow on the bus). Listeners come in two categories:
- **Core** — always active, non-disablable (degradation tracker, artifact writer, notification emitter)
- **Opt-in** — declared per recipe in the `listeners` array

**Consequences:** RxJS becomes a kernel dependency. Listeners subscribe via `eventBus.observe(filter)` returning `Observable<PipelineEvent>`. (The `AsyncIterable` face, `eventBus.subscribe(filter)`, was written for listener strategies that never landed and was removed by CH-16 with zero callers.) The interface stays stable so V2 persistence (DuckDB sink) is a non-breaking addition.

---

## ARCH-11 — V1 is synchronous request/response only

**Status:** Accepted

**Context:** Long-running recipes (especially with future agent strategies) could justify async run IDs + polling. But the conversation between LLM and MCP is fundamentally ping-pong.

**Decision:** V1 is sync only. Each tool call is request/response. No `runId + subscribeRun` pattern. If a recipe needs to run for minutes, it blocks the call for minutes.

**Consequences:** Agent strategies (V1.5+) must respect this — their internal sub-agent calls happen during the synchronous wait. If async becomes necessary later, the addition is non-breaking (new endpoints).

---

## ARCH-12 — Artefacts persist as JSON files in `~/.labre-mcp/runs/`

**Status:** Accepted

**Context:** Cross-run analytics, debugging, and benchmarking all benefit from persisted recipe traces. The conversation transcript (Claude Code's harness) is the primary memory; structured artefacts are the queryable layer.

**Decision:** Each recipe execution emits a JSON artefact at `~/.labre-mcp/runs/<projectId>/<runId>.json`. Format is verbose and LLM-readable (descriptive keys, inline metadata). Versioned via `schemaVersion`. V1 writes them; V2 may add DuckDB lazy queries over them. Kafka is out of the trajectory.

**Consequences:** Core listener `artifact-writer` is non-disablable. `projectId` resolved from `.labre/project.json` UUID with hash-of-path fallback (see CP8).

---

## ARCH-13 — Primary memory is the conversation transcript, not memory.md

**Status:** Accepted

**Context:** Earlier discussion conflated "persistence" with the auto-memory system (memory.md). They serve different purposes.

**Decision:** The primary memory of a labre-mcp session is the harness-saved conversation transcript (Claude Code's JSONL log). The auto-memory system (memory.md) remains scoped to its original purpose: user profile, feedback, project meta-info — never recipe artefacts. labre-mcp neither reads nor writes memory.md.

**Consequences:** Cross-session navigation happens via the transcript and the JSON artefacts. labre-mcp produces structured artefacts that the conversation can reference; it does not maintain its own narrative log.

---

## ARCH-14 — Daemon HTTP localhost transport, SaaS-ready by design

**Status:** Amended by ARCH-27 — the transport decision itself stands (HTTP daemon on localhost, stdio alongside it), but the daemon is no longer a kernel module: it moved out of `src/core/transport/` to `src/transport/`, it no longer builds its own tool registry, and MCP over HTTP is now one delivery among possible others. See ARCH-27.

**Context:** The current MCP server runs per-project via stdio. This conflicts with using the Claude Agent SDK (which spawns sub-processes that collide with active Claude Code sessions). It also makes the trajectory to a hosted multi-tenant service expensive (different transport, different state model).

**Decision:** labre-mcp runs as a locally-installed daemon, exposing MCP over HTTP on localhost (default port 6767). Transport choice intentionally aligns with V3 SaaS: same protocol, different host + auth.

**Consequences:** All tool calls become self-contained (no implicit `cwd`). The Agent SDK is usable inside the daemon (no Claude Code session conflict). Auth is a no-op middleware in V1, real in V3 (see ARCH-15). Existing stdio support is dropped in CP10.

---

## ARCH-15 — `process.cwd()` forbidden at runtime; context propagated explicitly

**Status:** Amended by ARCH-27 — the invariant stands unchanged (no `process.cwd()` at request time; every call carries its context), but the context is no longer ONE object carrying three natures. The kernel receives the business nature plus a minimal `userId`; the auth nature (role, raw bearer, issuer provenance) lives at the delivery seam and is stripped by the dispatch. See ARCH-27, third cut.

**Context:** A daemon serves multiple projects. Implicit `process.cwd()` resolution is meaningless and dangerous.

**Decision:** Every tool call carries a `context` object:
```ts
RequestContext = {
  projectId: string;
  projectRoot: string;
  sessionId: string;
  domain: string;       // e.g. "wardley"
  artifactDir?: string; // optional override
}
```

Reading `process.cwd()` or `process.env.X` outside the daemon boot (top-level config loading) is forbidden. All path resolution is relative to `context.projectRoot`.

**Consequences:** Config loaders (`llm.config`, `recipes`) take `projectRoot` as explicit parameter. Config is loaded once at boot for shipped defaults; per-request overrides are merged from `${projectRoot}/<config>` at call time.

---

## ARCH-16 — Migration is big bang; no backwards compatibility

**Status:** Accepted

**Context:** A staged migration with shim layers between old and new naming would multiply complexity without immediate value. The user is the only consumer.

**Decision:** Migrate in one big bang sequence. No `'all'`-style aliases, no dual registration, no compat shims. Each checkpoint leaves the build green; the final checkpoint cuts over completely.

**Consequences:** Tests, skills, and downstream consumers must all migrate together. A pre-migration commit checkpoint protects the current state.

---

## ARCH-17 — Migration order: kernel → strategies → recipes → skills → docs → rename

**Status:** Accepted

**Context:** A topological order minimises broken-build windows.

**Decision:** Sequence:
1. Foundation (snapshot, ADR, AGENT.md skeleton) — CP1
2. Kernel (registry, runner, bus, AST contracts) — CP2
3. Transport (HTTP daemon) — CP3
4. Migrate chain tool — CP4
5. Migrate evolution tool + AST γ — CP5
6. Recipes canonical — CP6
7. Skills update — CP7
8. Persistence — CP8
9. Documentation final — CP9
10. Renaming + GitHub remote — CP10

**Consequences:** Strategies can move only after the kernel exists. Recipes need both strategies and runner. Skills depend on recipes. Renaming is last — it's the cutover.

---

## ARCH-18 — Repo renamed including GitHub remote at end of migration

**Status:** Accepted

**Context:** Renaming `WardleyAssistant` to `labre-mcp` mid-migration would invalidate IDE state, CI references, MCP client config, and import paths simultaneously. Doing it last contains the disruption to a single window.

**Decision:** All renaming (package.json, source mentions, sed) happens in CP10. Local directory rename via `git mv ../WardleyAssistant ../labre-mcp`. GitHub remote rename: documented manual step (`gh repo rename labre-mcp` or via UI) — not automated by the migration plan since it's a publish action requiring user judgement.

**Consequences:** Workflow remains stable until CP10. Post-CP10, all clients (Claude Code's `.mcp.json`, etc.) update at once.

---

## ARCH-19 — AGENT.md restructured + `docs/architecture/` documents principles

**Status:** Accepted

**Context:** Architectural decisions need a stable home.

**Decision:** AGENT.md (CP9) carries the project's mission, top-level architecture, hard rules, and pointers. Detailed decisions live in `docs/architecture/decisions.md` (this file) and per-topic docs (`strategies.md`, `recipes.md`, `transport.md`, `persistence.md`).

**Consequences:** AGENT.md scannable for newcomers; ADR doc authoritative for reasoning. ADRs are append-only.

---

## ARCH-20 — Deferred to V1.5+: versioning, agent strategies, cycle tool

**Status:** Partially superseded by AST-schema v0.1.0 — SemVer triplet versioning (`@x.y.z`) is adopted from v0.1.0 for both the AST as a whole and individual strategies (no longer deferred). The `cycle` tool is renamed `iteration` and is fully in scope. Agent strategies remain deferred. See [ast-schema.md](ast-schema.md) § 3.2.

**Context:** Ambitions worth tracking but not blocking V1:
- Strategy versioning (`@v1`, `@v2`) — useful for benchmarks, but no current driver.
- Agent strategies (sub-agent backed) — powerful but expensive; defer until a use case demands it.
- The `cycle` tool — meta-orchestrator across the five other Wardley tools; deferred until at least 3 of those tools exist.

**Decision:** Document as deferred. Do not scaffold. Re-evaluate when a concrete use case arrives.

**Consequences:** Strategy methodIds in V1 omit `@version`. Registries are version-naive. The `cycle` tool's directory is not even scaffolded.

---

## ARCH-21 — Three categories of configuration

**Status:** Accepted

**Context:** Different config files have different semantics regarding user override.

**Decision:** Three categories:
1. **Runtime config (user-facing, override-able)** — `recipes/`, `llm.config.json`. Shipped by labre-mcp, overridable at `${projectRoot}/<config>` via merge.
2. **Strategy assets (developer-facing, not override-able)** — `prompts/*.system.md`, `prompts/*.user.md`, internal strategy configs. Live with the code, not user-overridable. Evolve with strategy versions.
3. **Project artefacts (user-managed)** — `.wm` files, generated artefacts. Live in the user's project, never in labre-mcp's source.

**Consequences:** The merge logic only runs for category 1. Category 2 is loaded from labre-mcp's own filesystem. Category 3 is read/written via `context.projectRoot`.

---

## ARCH-22 — Strategy result format: `{ signals[], reasoning[], insights[], result }`

**Status:** Accepted

**Context:** The current `EvolutionResult` is `{ evolution, confidence, method }` — three numbers. The LLM's reasoning trace, the input signals, and any higher-level insights are produced internally and discarded. This is a permanent loss of analytical value.

**Decision:** Every strategy result captures four arrays/objects:
- `signals[]` — typed observations consumed as input (e.g. `{ name: "certitude", value: 0.9, source: "user-input" }`)
- `reasoning[]` — captured LLM reasoning trace (`{ by: methodId, text: "...", tokens?: {...} }`)
- `insights[]` — higher-level interpretations (`{ text: "...", by: methodId, type: "trajectory" }`)
- `result` — the canonical numerical/structural output (`{ evolution, confidence, method, consensus? }`)

For the evolution tool specifically, the AST is `WardleyEvolutionAST` (γ form): the chain map carries a lightweight `EvolutionAnnotation = { value, method, confidence, analysisRef? }` referencing the full analysis stored in evolution AST.

**Consequences:** Strategies must be refactored to capture instead of discard. Prompts may need updating to preserve LLM reasoning. Artefacts become rich enough to support cross-run analytics in V2.

---

## ARCH-23 — Strategy migration is in-place inside `_legacy/`

**Status:** Accepted

**Context:** During the kernel-and-frameworks reorg, the strategy classes lived under `src/work-on-{value-chain,evolution}/`. Migrating each class to the new `BaseStrategy` contract while ALSO physically moving the file to the canonical `src/frameworks/wardley/<tool>/<command>/<subdomain>/` location would have entangled two changes — refactor-of-contract and rename — in a single commit, multiplying the risk of import breakage and test churn.

**Decision:** Migrate strategies in place. Edit the file at its current `_legacy/` path, change the parent class to the core `BaseStrategy`, update the `static method` getter to the 5-segment id, and register the class via the framework's `register*Strategies(registry)` function. Defer the physical move to a later cleanup wave, scheduled for V1.5.

**Consequences:** The directory layout temporarily looks inconsistent (`src/frameworks/wardley/evolution/_legacy/...`) but every file independently builds, types, and tests green at each checkpoint. The `package.json#imports` field carries transitional aliases (`#work-on-evolution/*`, `#work-on-value-chain/*`) that point into `_legacy/`; these aliases retire with the final move.

---

## ARCH-24 — `analysisRef` is a structured pointer, not an opaque string

**Status:** Deferred — the `AnalysisRefSchema` was drafted in V1 but never written at runtime; it was removed in the post-v0.1.0 cleanup along with `WardleyChainAST` and `WardleyEvolutionAST`. The structured-pointer shape will be recreated when the recipe runner needs to cross-reference detailed analyses from chain components. `envelope.references[]` carried the same intent and was likewise never written: CH-12 removed it from the contract (runner type, Zod schema, published JSON Schema) rather than keep publishing an always-empty field. It comes back **with** its producer, not before.

---

## ARCH-24-ORIGINAL (preserved for history)

**Status:** Accepted

**Context:** `EvolutionAnnotation` (the lightweight evolution data attached to a chain component) needs to point at the richer `WardleyEvolutionAST` artefact that justifies it. The original schema typed `analysisRef` as `string | null` — an opaque path. Callers had no machine-readable way to navigate into the artefact, no way to specify which sub-tree of the analysis the annotation summarises, and no validation against malformed values.

**Decision:** `analysisRef` is `{ artifactPath: string; jsonPath?: string } | null`. `artifactPath` resolves to a JSON artefact produced by the artifact-writer listener (relative to the run's artifact dir, or absolute). `jsonPath` is an optional JSONPath into that artefact pointing to the specific node — defaults to `$.result` when omitted. Null means "no detailed analysis produced".

The shared type was specified as `src/core/ast/analysis-ref.mts` (`AnalysisRefSchema` / `AnalysisRef`) — **never written at runtime and removed in the post-v0.1.0 cleanup; see the Status header of ARCH-24 above.** Any tool that links an annotation to an artefact will use this schema once recreated.

**Consequences:** Cross-tool navigation (chain → evolution AST → specific reasoning entry) is type-safe. Future tools (climates, doctrines) reuse the same pointer shape when annotating chain components. Migration is non-breaking because no V1 call site has yet written `analysisRef` at runtime.

---

## ARCH-25 — `ast-schema.md` v0.1.0 is the new pivot grammar

**Status:** Accepted

**Context:** The accumulated learning from V1 (chain + evolution migration, recipe runner, post-audit refactor) revealed that the original 5-segment grammar (ARCH-03) and the fixed four-command vocabulary (ARCH-04) did not scale to the full Wardley study cycle (purpose → value-chain → climate → doctrine → gameplay → iteration) plus the rendering domain (OWM, image) plus the listing/introspection domain. The asymmetry `chain` vs `evolution` at the tool level (both are aspects of the same map artefact) became a recurring source of taxonomic friction. The render schema, kept at arm's length under ARCH-05, in practice needed elevation to a communication norm.

**Decision:** [`docs/architecture/ast-schema.md`](ast-schema.md) v0.1.0 is the **single source of truth** for the labre-mcp grammar, the tool/sub-domain hierarchy, the recipe/listener format, the strategy contract, and the SemVer policy. It supersedes or amends ARCH-01, ARCH-02, ARCH-03, ARCH-04, ARCH-05, ARCH-06, ARCH-10, ARCH-20 (see each ADR's status header for the specifics). All future development — strategies, registries, AST schemas, recipes, skills — conforms to `ast-schema.md`. Where this document and an older ADR disagree, `ast-schema.md` wins.

**Consequences:**
- Every existing methodId in the codebase (e.g. `wardley:chain:write:map:top-down`, `wardley:evolution:write:capacity:llm-direct`) must be migrated to its new form (e.g. `wardley:map:value-chain:generate:top-down`, `wardley:map:climate:position-functional-in-evolution:llm-direct`). See the migration table in [ast-schema.md](ast-schema.md) § 3.3.
- The strategy contract is formalised in [ast-schema.md](ast-schema.md) § 3.4 — annexe « Contrat de strategy v0.2 » — which reinforces ARCH-22's `{ signals[], reasoning[], insights[], result }` invariant and adds explicit strategy metadata (cost class, confidence baseline, latency class).
- `JSON-labre` is the canonical artefact shape: a métier sub-tree per `wardley.*` aspect (conformant to its tool schema, the renderer schema in the case of `wardley.map`) plus a transverse `envelope` carrying `signals`, `reasoning`, `insights`, `trace` (cf. ARCH-22). The spec also listed `context` and `references` here; neither ever had a producer, and CH-12 removed both from the contract — `context` belongs to the business sub-tree of the command that produces it (`wardley.iteration`), `references` returns with ARCH-24's writer.
- ADRs are still append-only and immutable; the supersession is marked via the `Status:` header of each impacted ADR. The original decision text is preserved as historical context.
- The `StrategyMetadata.status` enum in [ast-schema.md § 3.4.3](ast-schema.md) includes the value `"mock"` to mark scaffolded I/O contracts that have no real implementation yet. Mock strategies live under `src/frameworks/**/*.mock-strategy.mts` and are registered via `registerMocks(registry)` after the real strategies at daemon boot, so the MCP catalogue exposes the full v0.1.0 surface from day 1.

---

## ARCH-26 — The `labre_mcp` schema stays in labre's migration chain; labre-mcp guards it with a mechanical contract

**Status:** ✅ **Accepted — human arbitration 2026-08-26** (option (c) as recommended). Cross-product decision (labre ↔ labre-mcp), red zone: it touches schema ownership, RLS and grants. Nothing was applied to either repository beyond this ADR and the contract + test it describes; no migration is moved, created or deleted by this change.

**Context:**

The AI-harness audit recorded that "the `labre_mcp` schema migrations live in neither repository" and proposed labre-mcp as their home. **That premise is wrong, and it matters.** The migrations do exist, and they live in **labre**:

| Migration (in `labre/supabase/migrations/`) | What it does to `labre_mcp` |
| --- | --- |
| `20260707000100_strategy_bundles.sql` | creates `strategy_bundles` — in `public` at the time |
| `20260711130000_labre_mcp_schema.sql` | creates the schema, grants `usage`, relocates `strategy_bundles` into it |
| `20260711130100_labre_mcp_api_keys.sql` | creates `api_keys`, its RLS policy, its grants, and the three RPCs |
| `20260715150000_user_entitlements.sql` | touches `strategy_bundles` |
| `20260726094500_revoke_trigger_functions.sql` | names `labre_mcp` in the "no PUBLIC-executable function" rule |
| `20260728120000_revoke_anon_execute_drift.sql` | exempts `labre_mcp.validate_api_key` from the anon-EXECUTE sweep, deliberately |

So the problem is not homelessness. The problem is **ownership**: this repository codes against a schema whose definition is legislated by another product, and nothing mechanical connects the two.

- `src/lib/bundles/supabase-bundle-source.mts` reads `labre_mcp.strategy_bundles` (`slug`, `version`, `files`, `storage_prefix`, `updated_at`), under the caller's JWT, filtered by an RLS policy on `enabled`.
- `src/core/transport/api-key-auth.mts` calls `labre_mcp.validate_api_key` over PostgREST with `Content-Profile: labre_mcp`, under the public anon key. The `anon` EXECUTE grant on that one function is the daemon's entire front door.

A column renamed, a policy narrowed, an EXECUTE grant swept up by a hygiene migration: each ships green in labre — its own tests never load this code — and arrives here as a production incident. Between the two repositories there is currently **no test, no type, no CI step, no review rule**. The drift is silent by construction.

There is also a hard operational constraint that shapes the options: **the Supabase CLI maintains one migration chain per project.** Two `supabase/migrations/` directories in two repositories pointing at one database is a well-known operational hazard — interleaved timestamps, a shared `schema_migrations` ledger neither side owns, and a `db push` from either repo able to strand the other. labre's PRs already auto-apply migrations to staging; a second chain would race that.

**Options considered:**

**(a) Move the `labre_mcp` migrations into labre-mcp.** Ownership becomes obvious: the product that reads the schema also legislates it. But it buys the second migration chain described above, against a Supabase project labre-mcp does not own and holds no credential for — and holding no privileged credential is a load-bearing invariant of this daemon ([mcp-data-store-position.md](mcp-data-store-position.md)). It would also split `20260726094500` and `20260728120000`, which sweep `public` and `labre_mcp` in one pass precisely because the rule they enforce is repo-wide. The cost is paid every day; the benefit — a name on a directory — is paid once.

**(b) Status quo, documented.** Cheapest. Leaves the drift silent, which is the entire finding. Rejected: an audit that ends in a paragraph nobody executes has changed nothing.

**(c) Ownership stays split, but the split becomes mechanical.** — **recommended.**

**Decision (accepted 2026-08-26):**

1. **The migration chain stays in labre**, where the Supabase project and its single `schema_migrations` ledger live. One chain, one owner, no race.

2. **labre-mcp gains a schema contract**: [`src/lib/schema-contract/labre-mcp.contract.json`](../../src/lib/schema-contract/labre-mcp.contract.json) — the schema this code needs, declared in this repository: tables, columns with type/nullability/default, primary keys, unique and foreign-key constraints, RLS on/off, the RLS policies, the table grants for `anon`/`authenticated`/`service_role`, and the three RPCs with their `SECURITY DEFINER` flag and EXECUTE holders. It is extracted from a **live** database by the very introspection query that verifies it, not transcribed from the migrations — what is guarded is the state they produce, not the SQL that claims to produce it.

3. **The contract is verified by a test**, [`schema-contract.test.mts`](../../src/lib/schema-contract/schema-contract.test.mts), on the ordinary `pnpm test` runner (`tsx --test`). It introspects `pg_catalog`/`information_schema` when a **local** stack answers, and fails on a missing table, column, constraint, grant, policy or function — **and on an unexpected one**, because a role that gains a privilege nobody declared is the drift that hurts. Reaching the database is loopback-only: a `SUPABASE_DB_URL` pointing anywhere else throws rather than connects, and the fallback path (`docker exec`) cannot reach a remote host at all. With no stack the suite **skips loudly** — a warning naming what was not verified — and the diff engine's own tests still run against planted drift, so the guard is never entirely invisible. Not wired into CI: CI has no Supabase stack, and a guard that cannot run there is decoration, not a gate.

4. **Process rule.** Any change to the `labre_mcp` schema is **one migration in labre AND one contract update in labre-mcp, in the same batch.** The field belongs **functionally to labre-mcp**: labre hosts the migration, labre-mcp says what the shape must be, and the labre-side change is a cross-review. A migration that alters `labre_mcp` without a matching labre-mcp PR is incomplete, not merged-and-followed-up.

5. **Reopening trigger.** If labre-mcp ever acquires genuinely MCP-owned mutable state (trigger 2 of [mcp-data-store-position.md](mcp-data-store-position.md)), it gets its own database, and option (a) becomes correct for that database — with its own project, its own chain, and no shared ledger. This ADR governs the current arrangement only: a schema inside labre's project, read by labre-mcp.

**Consequences:**

- Drift becomes a **red test on this side**, hours after it lands rather than at the next production incident. That is the whole point; everything else is bookkeeping.
- The contract is a **maintenance obligation** — and deliberately a small, mechanical one. A false red is a one-line edit, and the edit is the documentation.
- **Two things stay outside the mechanical guard**, both named in the contract's `notInContract`: the `strategy-bundles` Storage bucket and its policy on `storage.objects` (Supabase-managed schema — the same boundary labre's own `grants_coherence.sql` respects), and the PostgREST **"Exposed schemas"** dashboard setting, which is not a schema object and which migration `20260711130000` still flags as manual on prod. Neither can be introspected as part of `labre_mcp`; both will break the daemon if changed.
- **`anon` retains `REFERENCES`, `TRIGGER` and `TRUNCATE` on `strategy_bundles`** — residue of the `public` defaults the table was relocated from. None grants a read or a write, and the contract deliberately does not freeze them; recorded here so the next reader does not rediscover it as a finding.
- labre gains a **pointer, not a rule enforced from outside**: a paragraph proposed for its `CLAUDE.md` or docs saying that `labre_mcp` is labre-mcp's field and carries a contract elsewhere. Where that paragraph lands is the human's call — nothing was written into labre by this change.

---

## ARCH-27 — The façade: labre-mcp is a kernel with deliveries; MCP is one of them

**Status:** ✅ **Applied — human arbitration C1, option A, 2026-08-25.** Executed by chantier CH-23 (AI-harness audit, wave 4). This ADR records an arbitration already rendered; it does not ask for one. It amends **ARCH-14** (which placed the transport inside `src/core/`) and **ARCH-15** (which defined a single `RequestContext` carrying auth), and it lifts the CH-06 import-boundary baseline to **zero entries**.

**Context:**

The audit's invariant **I2** — "transport state stays separate from business state" — shipped red, and the guard `scripts/check-import-boundaries.mts` said so out loud: **seven** tolerated crossings enumerated in `scripts/import-boundaries-baseline.json`. They were not seven accidents. They were one architectural fact seen from seven angles: **the transport lived inside the kernel**, at `src/core/transport/` (ARCH-14), and its boot wiring reached UP into `src/mcp/` — in VALUE, not in type — to build its tool registry.

Four consequences, each independently costly:

1. **The kernel could not be embedded.** Importing anything from `src/core/` risked dragging in a Hono server, an auth middleware and a JWKS client. "Run this strategy" was not callable except through a JSON-RPC `tools/call`.
2. **The wire knew the product.** `boot-tool-registry.mts` named five MCP tool descriptors. Swapping or adding a delivery meant editing the transport.
3. **`RequestContext` carried three natures at once** — business (project root, session), transport (which client), auth (user id, role, and a raw verified bearer). A geometry strategy asking for its project root received, in the same object, a live user JWT.
4. **The runner made billing calls.** `core/recipe/recipe-runner.mts` called `assertQuotaOk()` before the first step and `reportUsageToLedger()` after the last: two Supabase round-trips hard-wired into the kernel's execution path, which made it un-runnable offline and tied it to labre's billing schema.

The human's arbitration (2026-08-25, C1 option A) states the product reason: *labre-mcp is a product in its own right, consumable independently by another harness (Claude Code, a CLI, third-party agents), and also consumable by labre's own harness.* MCP is therefore **a delivery, not an identity**, and the lib mode has to open.

**Options considered:**

**(a) Leave it, document it.** The baseline already documented it. Rejected for the same reason ARCH-26 rejected its own status quo: an audit finding that ends in a paragraph nobody executes has changed nothing — and CH-24 (the prompts/resources costume) and CH-26 (the plugin runtime) both have to be BUILT on this seam. Cutting it after they land costs strictly more.

**(b) Extract the kernel into a separate package.** Cleanest boundary, since a published package cannot import what it does not depend on. Rejected for now: two packages means two versions, two release trains and a lockstep bump on every kernel change, for a repository whose whole surface is six tools. The directory boundary plus a mechanical guard buys most of the invariant at none of that cost, and the split stays available the day an external consumer actually vendors the kernel alone.

**(c) One package, three layers, guarded mechanically.** — **chosen (= arbitration A).**

**Decision:**

The repository is three layers and the dependency points ONE way — **delivery → transport → kernel**:

| Layer | Holds | May import |
| --- | --- | --- |
| `src/core/` (+ `src/frameworks/`, `src/lib/`, `src/schemas/`) | registry, recipe runner, bus, AST contract, context, persistence, the strategy catalogue | itself |
| `src/transport/` | HTTP daemon, stdio server, JSON-RPC dispatch, auth doors, boot health checks, tool telemetry | the kernel |
| `src/mcp/` | the six MCP tool descriptors, the tool composition, the metering policy, the two composition roots | the transport and the kernel |

**Four cuts:**

1. **The transport leaves the kernel.** `src/core/transport/` → `src/transport/`, reached through a new `#transport/*` subpath alias. The kernel no longer contains a server.

2. **The boot dependency is inverted.** `boot-tool-registry.mts` becomes `src/mcp/tool-registry.mts` (`buildMcpToolRegistry`) and is the ONLY module that names a tool. The registry CONTRACT (`ToolDefinition`, `ToolRegistry`) moves into the kernel at `src/core/registry/tool-registry.mts`; `startHttpDaemon` and `startStdioServer` become functions taking an already-filled registry. Two thin composition roots — `src/mcp/labre-daemon.mts` and `src/mcp/labre-stdio.mts` — are where the tool surface, the framework catalogue and the wire meet, and they are the `bin` and the npm scripts. Two supporting relocations fall out: `SHIPPED_ROOT` (a packaging fact, not an MCP fact) to `src/core/shipped-root.mts`, and `buildStrategyRegistry` to `src/frameworks/registry-boot.mts` — composing frameworks is a framework concern, so the kernel now knows no framework either.

3. **`RequestContext` is split by nature.** The kernel's type keeps the business fields plus ONE minimal identity, `userId` — an opaque id for quota attribution, RLS scoping and telemetry bucketing. The auth nature (`userId`, `role`, `token`, `source`) lives at the delivery seam in `src/transport/auth-context.mts` as `AuthContext` / `AuthenticatedContext`; `withAuth` is its single writer and `toBusinessContext` its single reader inward. **`dispatch` IS the seam**: it strips the auth nature before calling a handler, so no bearer can reach a strategy, an artefact or a log — it is not in the object they receive. `auth.token` and `auth.source` are **kept** (human decision, 2026-08-26): they have had no reader since slice B4, but whether the daemon should stop retaining a verified bearer is an AUTH decision (red zone, CODEOWNERS), not a side effect of a layering refactor. What changes is their blast radius. A hardening falls out for free: `extractContext` now drops a client-supplied `userId`, so identity can only come from a verified credential.

4. **Quota and ledger leave the runner.** `RunHooks` (`beforeRun` / `onUsage`) is a seam the runner announces and never fills. labre's policy — the same two calls, unchanged — lives in `src/mcp/metering-hooks.mts` and is passed by the five MCP tool paths. Nothing changes on the wire (both calls were already no-ops without a caller JWT, and that is exactly the population reaching them); what changes is who decides.

**Lib mode** is the deliverable this buys. `src/index.mts` exposes the kernel — catalogue builder, `runCommand` / `runRecipe` with the JSON-labre envelope, recipe loader and schema, strategy and context contracts, tool registry, event bus, artefact writer — and deliberately exposes no daemon, no dispatch and no tool descriptor.

**Two mechanical guards, both required to stay green:**

- `pnpm check:boundaries` walks **both** `src/core/` and `src/transport/`. Its three rules are now unconditional — core imports neither transport nor mcp; transport does not import mcp — and `import-boundaries-baseline.json` is **EMPTY**. Since the guard also fails on a baseline entry matching nothing (rule STALE), neither an unnoticed violation nor a stale exemption survives a run. **A new baseline entry is a request to re-open this ADR.**
- `src/lib-mode.test.mts` walks the transitive import graph of `src/index.mts` and fails on any file under `src/transport/` or `src/mcp/`, then builds the full catalogue and runs a deterministic command with `fetch` replaced by a throwing stub. A daemon that merely happens not to be started is not a library; a daemon that is not reachable is.

**Consequences:**

- **CH-24 (prompts/resources) and CH-26 (the plugin runtime) build on this seam**, not beside it. A prompt/resource surface is another set of entries in a kernel-owned registry composed by a delivery; a plugin runtime fills that registry at load time. Neither needs to touch `src/core/` or `src/transport/`.
- **Adding a delivery is writing one file.** A CLI, an in-process embedding for labre's own harness, or a different protocol composes its own registry and calls `startHttpDaemon` / `startStdioServer` / nothing at all.
- **The delivery-level integration tests moved with their subject.** The three suites that exercise the MCP surface OVER a wire (`http-transport`, `stdio-transport`, `boot-parser-registration`) now live in `src/mcp/`; the transport keeps the unit tests that need no tool to run (auth doors, JWKS, api-key, health checks). That is not cosmetic — it is what makes the TRANSPORT_TO_MCP rule true for tests as well as for production code.
- **The kernel is still not a published package** (option (b) stays on the table). The boundary is a directory boundary held by a guard, not by npm. The reopening trigger is an external consumer that needs to vendor the kernel without the deliveries.
- **`src/lib/` is still not under `src/core/`** (roadmap B1) and `_legacy/` strategies have still not been extracted (ARCH-23). CH-23 deliberately did not touch either: they are orthogonal to the façade, and bundling them would have made a layering change unreviewable.

---

## ARCH-28 — The MCP costume: prompts and resources, served from the kernel, DATA-ONLY

**Status:** ✅ **Accepted — executed by chantier CH-24 (AI-harness audit, wave 4).** Builds on **ARCH-27** (the façade) without amending it, and is the first delivery-side change that had to obey it. It reserves nothing from **C4 / CH-26** (the plugin runtime), whose arbitration is still open.

**Context:**

The audit's finding was one sentence: labre-mcp had "remained an execution proxy — capabilities = tools only (`mcp-handler`); MCP costume (prompts / resources) MISSING". The consequence is easy to state and was easy to miss. A third-party harness — Claude Code, a CLI, another agent — that connected to this daemon received **six executable tools and nothing else**. It could RUN the framework and could not LEARN it:

- **No method.** How a practitioner separates a component's capability from the solution implementing it, how an anchor is placed on the evolution axis, in what order a value chain is written — all of that existed, as prose, inside `prompts/*.system.md`, reachable only from inside a strategy's own LLM call. A harness with its own model could not obtain it.
- **No knowledge.** `runCommand` takes a 5-segment methodId. The grammar of that id lived in a 1500-line French pivot document; the list of ids that actually exist lived in a registry with no listing; whether a given id really computes or answers deterministic scaffold data lived nowhere at all. The JSON Schemas were served over `GET /schemas/:file`, an HTTP path nothing advertises and stdio cannot reach. The shipped recipes had no listing at all: `loadRecipe` answers "give me this one" and cannot answer "what do you have".

MCP has had `prompts/*` and `resources/*` since the beginning. The gap was not protocol knowledge; it was that nothing in this repository could ENUMERATE itself.

**Options considered:**

**(a) Ship the costume as static files served by the transport.** Fastest. Rejected: it puts product content inside the wire, which is exactly the crossing ARCH-27 spent a chantier removing, and it guarantees a hand-maintained second copy of the grammar and the catalogue — the copy that drifts.

**(b) Make the costume executable: let a prompt run a strategy, let a resource take parameters.** Tempting, and genuinely more powerful — a resource that could answer "the catalogue filtered to `wardley:map:`" is more useful than one that returns everything. Rejected **for this chantier**, on a boundary rather than on taste: a parameterised resource is a tool wearing a URI, and loading executable content at run time is the subject of C4 / CH-26, which the human has not arbitrated. Building it here would pre-empt that arbitration in code.

**(c) Kernel-owned data catalogues, delivery-owned composition, transport-owned protocol.** — **chosen.** It is the shape ARCH-27 already prescribes, applied to a second surface.

**Decision:**

1. **The kernel gains data catalogues.** `listPromptCatalog()` (`src/lib/prompts/catalog.mts`), `listShippedSchemas` / `readShippedSchema` / `listShippedRecipes` (`src/core/catalog/shipped-assets.mts`), `GRAMMAR` (`src/core/catalog/grammar.mts`) and `StrategyRegistry.catalogue()`. All four answer the question nothing could answer before — *what is there* — and all four are plain data: no handle, nothing to execute, no server anywhere in the graph. They are exported from lib mode, so an embedding consumer gets the same discovery surface a third-party harness gets over the wire.

2. **Implementation provenance becomes part of the catalogue.** `StrategyRegistry.registerMock()` is a second registration verb with identical behaviour and one added fact. A harness must be able to tell a deterministic scaffold from a real computation **before** it spends a call trusting the answer, and `mock` was previously knowable only from a class-name prefix — a naming convention, not a contract. Provenance is now declared at the composition root that knows it (`src/frameworks/mocks-registry.mts`; since CH-26 / ARCH-29 that root is `src/frameworks/fixtures-registry.mts`), so promoting a mock means deleting its line there, which is exactly what flips the catalogue.

3. **`PromptRegistry` and `ResourceRegistry` join `ToolRegistry` as kernel contracts.** Same shape, same reasoning (ARCH-27, cut 2): the kernel owns the type, `src/mcp/` composes an instance, the transport receives it filled and names nothing in it. A `ResourceDefinition.read()` takes **no argument, by contract** — that is the data-only limit of this ADR stated as a type rather than as a paragraph.

4. **The dispatch serves four read-only methods** — `prompts/list`, `prompts/get`, `resources/list`, `resources/read` — and both registries are **optional at that seam**. `initialize` advertises a `prompts` / `resources` capability only for a registry it was actually handed: a capability is a promise, and one made for a surface that will answer `MethodNotFound` is a lie a client acts on. Neither declares `listChanged` — the costume is data shipped with the package and fixed for the life of the process.

5. **Auth needed no change, and that is the finding.** The HTTP transport authenticates the whole `POST /mcp` before dispatch is reached, so the costume rides the same door as `tools/*` with no per-method exemption to write and none to forget. It is pinned by test anyway: all four methods answer `401` / `-32001` without a bearer.

6. **Telemetry gets its own event, `mcp_costume_call`.** These methods consume no model and cost nothing; folding them into `mcp_tool_call` would inflate the very numbers CH-09 exists to make honest. Same instrumentation discipline — emitted once at the dispatch, so a method cannot ship unmeasured — and the same cardinality rule: `target` is set only when the entry RESOLVED from a registry, never from a caller-invented id.

**The prompt selection criterion.** The registry holds around twenty prompts; six are published. A prompt enters the costume when all four hold: it is **template-kind** (it IS data — two markdown files the package ships, not a code builder); it has an **invariant system/user pair** (the system half is the method, and the loader hard-fails if it carries a placeholder — a monolithic legacy prompt has no method to hand over, only one call's phrasing); it instructs a **framework judgement**, not internal machinery (which excludes the CPC patent mapper, the logprob provider workaround, the enrichment plumbing and the render I/O adapters); and every declared variable is **caller-suppliable** (which excludes prompts whose variables — `history_section`, `pacing_guidance`, `property_block`, `codes_list` — are computed upstream). The six: `identify-capability`, `anchor-evolution`, `historical-evolution__with-capability`, `publication-analysis`, `write-chain__top-down`, `purpose-generate`.

Required-vs-optional follows one rule: the prompt's **primary subject** is required, its qualifiers (description, context, date) are optional and interpolate empty — which is the registry's own contract. Rendering goes through `getPrompt().build()` rather than around it, so a bundle override or an active A/B variant applies here exactly as it does inside a strategy: one source of truth, two readers. MCP prompt messages carry no `system` role, so the invariant half is emitted as the FIRST user message.

**The URI scheme.**

```
labre://<category>[/<id>]

labre://grammar          the 5-segment addressing rules
labre://methods          the live methodId catalogue (real / mock / disabled)
labre://recipes          the shipped recipe catalogue, with runRecipe refs
labre://schemas/<id>     one published JSON Schema, <id> = filename minus .schema.json
```

Three rules it obeys. A URI **names a category, never a version or a path**, so a file moving or a strategy being promoted changes the content behind a URI and never the URI itself. `schemas/` is the only category with an id segment, and its ids come from the shipped directory listing — **no caller string is ever resolved into a path**. And nothing is parameterised (see option (b)).

The schema category is **mechanical**: it mirrors `schema/`, which is already exactly what the daemon serves on `GET /schemas/:file`, so the two surfaces cannot disagree and a schema added by `pnpm schemas` needs no second edit. The other three categories are one apiece — there is one grammar, one live catalogue, one shipped recipe set.

**Consequences:**

- **The façade paid for itself here.** The costume is two more lines in each composition root and **zero edits to product content in `src/core/` or `src/transport/`**. `pnpm check:boundaries` stayed at an empty baseline throughout, which is the claim ARCH-27 made and this is the first change that could test it.
- **The parity matrix grew a second half**, same discipline as the first: exact baselines in both directions for the six prompt names and the seven URIs, a per-method proof that the dispatch emits `mcp_costume_call`, and an assertion that it never emits `mcp_tool_call`. A seventh prompt cannot appear unnoticed; one of the six cannot vanish silently either. **`pnpm schemas` adding a file turns the resource baseline red on purpose** — a new public document is a decision, not a side effect.
- **A costume declaration is checked at BOOT.** An entry naming a prompt the registry does not hold, or forgetting a variable's help text, refuses to start rather than lying to every client that lists it.
- **The catalogue is now the honest count.** `labre://methods` reports 86 registered methodIds — 25 real, 61 mock, 1 disabled — computed, not transcribed. The numbers in `AGENT.md` had drifted (85 / 19 / 66), and this is why they cannot drift again.
- **DATA-ONLY is a limit, not a resting state.** Everything here is text this package ships. Three things a harness would reasonably want are deliberately absent and belong to C4 / CH-26: a prompt that can call a strategy, a resource that can be filtered by the caller, and any content loaded at run time from a bundle or a plugin. When that arbitration lands, it extends these registries; it does not replace them.
- **i18n is not in scope.** This is a machine surface; it is English, like the rest of the code base's technical surface.
## ARCH-29 — Plugin runtime security model: DATA-ONLY is load-bearing

**Status:** ✅ **Accepted — option (a), "extended status quo: richer DATA-ONLY
bundles". Human arbitration 2026-08-28.** No executable plugin runtime. The
four § 7 questions are answered below and the switching criteria stay live: this
ADR reopens in full the day one of them changes. Written by chantier
**CH-26** (AI-harness audit, wave 4), first tranche: the security ADR, zero
code. It instructs the human's **C4** arbitration (2026-08-25) — *"a hot plugin
runtime, with two non-negotiable guards: (a) an explicit re-design of the
`bundle = DATA-ONLY, no executable code` security model; (b) every plugin
activation is a traced event with a pinned version, otherwise replay dies"* —
and it does **not** render it. It builds on **ARCH-27** (a plugin runtime fills
a kernel-owned registry composed by a delivery) and would amend **ARCH-08** and
the bundle contract of [remote-admin-contracts.md](../technical/remote-admin-contracts.md)
only if an executable option is retained. Full evidence, threat model and option
analysis: [plugin-runtime-security.md](plugin-runtime-security.md).

First tranche shipped under this decision: **CH-26 mocks → fixtures** — the 61
mock strategies are now 61 lines of data plus one shared strategy
(`src/frameworks/fixtures-registry.mts`); `mocks-registry.mts`, the 61
`*.mock-strategy.mts` files and the `LABRE_DISABLE_MOCKS` flag are gone, and
fixture `capturedAt` comes from the injected run clock, closing the I3 leak this
ADR named. The same change renders **A4** and **A5**: `manifest.permissions` is
deleted (accepted and discarded on parse, so bundles already published against
v0.1 keep loading against the `.strict()` object; absent from the output type,
unreachable from any consumer, and its lone reader in the loader is gone), and
`signature?: string` is reserved — optional, never verified, not a control.

**Context:**

Today the catalogue is compiled into the binary. `buildStrategyRegistry()` is
six lines — five framework register calls plus the mocks behind
`LABRE_DISABLE_MOCKS` (`src/frameworks/registry-boot.mts:39-50`) — and
`mocks-registry.mts` is 61 hand-written imports and 61 hand-written
registrations (`src/frameworks/mocks-registry.mts:15-79`, `:82-142`). The
catalogue is **86 strategies: 25 real, 61 mocks** ([roadmap.md](roadmap.md); the
CH-26 backlog says 66 — the tree says 61). CH-26 wants a framework to arrive
without a daemon release.

What stands in the way is not inertia, it is a rule that is doing real work.
`src/schemas/strategy-bundle.schema.mts:3` states it in its first paragraph:
*"A strategy bundle is a DATA-ONLY package (no executable code)"*. A bundle is
`manifest.json` + one `recipe.json` + optional split prompt pairs, the manifest
schema is `.strict()`, and the loader's only verbs are `JSON.parse`
(`src/lib/bundles/bundle-loader.mts:81`) and a string read (`:96-107`) — no
`import()`, no `Function`, no `vm`, no `eval`. Every step of every bundle recipe
names a strategy the binary already contains (`:125-130`); every prompt override
must shadow a shipped one (`:200`); a bundle may never shadow a shipped recipe
(`:196-206`). A bundle **recombines and rewords**; it cannot add or replace a
capability.

Around that inert payload sits real hardening: the daemon holds no credential
and fetches with the **caller's** JWT on a per-refresh client it discards
(`src/lib/bundles/supabase-bundle-source.mts:107-121`, `:273-284`); every file
is sha256-re-verified and one mismatch rejects the whole bundle (`:235-246`);
the row is `service_role`-write-only against `authenticated:SELECT`
(`src/lib/schema-contract/labre-mcp.contract.json`, `strategy_bundles.grants`);
bad bundles degrade in isolation and the swap is atomic (`:317-347`).

**Four threats DATA-ONLY currently makes impossible**, each of which an
executable runtime reopens: **T1** arbitrary execution on the machine of a stdio
user, whose trust boundary *is* the spawning process; **T2** exfiltration of the
calling user's bearer — in a daemon that deliberately holds no privileged
credential, the caller's JWT is the most valuable secret in the process, and the
token that authorises loading a plugin is the token that plugin can steal;
**T3** artefact corruption, including retroactive edits to the very record that
would expose it; **T4** telemetry spoofing on an in-process bus, poisoning the
experiment store that [mcp-data-store-position.md](mcp-data-store-position.md)
makes the reason for having no experiments database.

**ARCH-27's dispatch seam does not cover this, and must not be cited as if it
did.** Stripping the auth nature before calling a handler means no bearer is *in
the object a strategy receives*. It is a shape guarantee, and it holds because a
strategy is code we wrote. In-process code we did not write reaches the same
heap, the other in-flight `AuthContext`s and `process.env` regardless.

**Two facts decide more than they look:**

1. **The 61 mocks are 61 copies of one program.** Every one is a 44-line file
   ignoring its input and returning `{ mock: true, methodId }` plus a
   `capturedAt`; all 61 match that `result` line byte for byte. They are **100 %
   expressible as data**. Whatever a hot runtime is for, it is not for them.
2. **Nothing records which code produced an artefact.** `ArtifactBody`
   (`src/core/persistence/artifact-writer.mts:16-28`) carries no version, no
   hash, no plugin list, and `PipelineEvent.phase`
   (`src/core/bus/event.schema.mts:14`) has four step phases and no lifecycle
   phase. While the code is the binary, provenance is implicit in the npm
   version. The moment a plugin can change what a methodId *does* without the
   daemon version moving, artefacts become unattributable and **I3 dies
   quietly** — a replay against different code has no way to notice. I3's known
   hole is already here: `capturedAt` escapes the injected `RunClock`
   ([recipes.md](recipes.md) § I3), and `new Date()` appears 61 times in the
   mocks and 26 times in real framework code.

Also recorded because an executable option would inherit it:
**`manifest.permissions` is decor.** The enum
`['llm','bigquery','network','render']`
(`src/schemas/strategy-bundle.schema.mts:39`) is read in exactly one place, to
check that a bundle declaring prompts also declares `llm`
(`src/lib/bundles/bundle-loader.mts:143-147`). Nothing enforces `network`.
Harmless for inert data; actively misleading on an executable payload.

**Options considered:**

**(a) Extended status quo — richer DATA-ONLY bundles.** Declarative fixture
strategies (methodId → constant payload, which covers all 61 mocks exactly),
declarative config strategies, recipe sets, richer prompt layering. Attack
surface added: ~none — the parser widens, nothing executes, and today's seal and
isolation keep holding *by construction*. Cost: low, mostly one-off, and it
closes an I3 leak for free (a fixture's `capturedAt` comes from the injected
clock). **What it forbids:** genuinely new computation. A framework plugin under
(a) is a framework whose logic we already shipped.

**(b) Minimal in-house loader.** Signed, hash-pinned JS modules via dynamic
`import()`, capabilities injected rather than ambient. This must be sold
honestly: an import allowlist **is not a sandbox** — an imported ES module
shares the realm and reaches `globalThis`, `process` and every live object graph
including other requests' auth. **(b) buys supply-chain control and essentially
no runtime containment.** Cost: high and recurring — a signing key and its
custody (nothing in either repo signs anything today), verification, revocation,
pinning, activation events, and `permissions` promoted from decor to an enforced
gate. Proportionate **iff** plugins are first-party only.

**(c) Cordis.** Evaluated on its own documentation, not by reputation. It is a
"meta-framework of spatiotemporal composability": `Context` as both DI scope and
lifecycle manager, demand-driven injection (a plugin declares required services
and does not run until they exist), effect tracking that unwinds everything a
plugin registered on dispose, and HMR. That lifecycle half is genuinely the part
`StrategyRegistry` lacks — it throws on duplicates and has no `unregister`
(`src/core/registry/strategy-registry.mts:44-46`). But its README and reference
docs mention **no sandboxing, isolation, permissions, signing, integrity or
trust boundary**: a Cordis plugin is ordinary Node code with full host
privileges. **Cordis is a composition framework, not a sandbox** — it does not
claim otherwise; the claim would be ours. It also states its API is not yet
stable and may change without notice, and adopting it replaces the six-line
composition root at `src/frameworks/registry-boot.mts:39` with a third-party
`Context`. It solves a problem we do not have yet and none of the problem we do,
and it does not remove (b)'s signing work — it adds a dependency on top of it.

**Containment is an orthogonal axis, not a fourth option** — needed by both (b)
and (c), provided by neither. Worker threads give a separate realm (killing the
direct form of T2) but keep `fs` / `net` / `child_process`. Node's `--permission`
model is process-wide, so it cannot express "the kernel writes artefacts, the
plugin does not" — exactly the distinction T3 needs. V8 isolates are the first
real boundary and the first real cost (native addon, serialisation, a
security-critical bridge we would own). **The rule worth writing down: the
containment requirement is set by who may author a plugin, not by what a plugin
does.**

**The two guards, as requirements a test can fail on:**

**G1 — activation is traced, version pinned.** `PipelineEvent` gains a
`plugin-activated` phase carrying `{ id, version, contentHash }`; `ArtifactBody`
gains a `codeProvenance` block, **present and empty** for a binary-only run
rather than absent; **replay refuses** when an artefact's provenance names a
plugin hash the process does not have loaded, failing loudly with both hashes
instead of replaying against different code; and a plugin receives the run clock
— no `capturedAt` from its own `new Date()`.

**G2 — the model is written before the first executable byte.** No module
reachable from a plugin path gains `import()` / `Function` / `vm` / `eval` / an
isolate binding, enforced by a grep-level gate in the `check:boundaries` family.
The fixture path added by CH-26 carries the gate as a source-level test
(`src/frameworks/fixtures-registry.test.mts`); extend it, or the
`check:boundaries` family, as further DATA-ONLY tranches land.
`manifest.permissions` is either enforced or deleted.

**⚠️ G2 was originally worded as "before this ADR's status moves off 🔴". That
wording is now wrong and has been replaced.** It was written when 🔴 was the only
thing holding the line, and read literally it would mean the 2026-08-28
acceptance *lifts* the guard — the exact opposite of what accepting (a) means.
Under (a) the prohibition is **permanent, not conditional on the status**: it
lapses only if a future arbitration retains an executable option, and such an
arbitration must say so in this ADR before any code is written. Revocation goes through the existing CH-18 `disabled` guard
(`src/core/registry/strategy-registry.mts:58-76`), the kernel's single
resolution point — one refusal channel, not two.

**Recommendation — ratified 2026-08-28. The argument below was accepted as
written; it is now the decision, not a proposal.**

**Take (a) now, and make (b) — never (c) alone — conditional on a named
requirement (a) cannot meet.** Three reasons, in order of weight:

1. **The evidence says the near-term work does not need code.** All 61 mocks are
   data. Migrating them retires `mocks-registry.mts` *and* `LABRE_DISABLE_MOCKS`
   *and* 61 stray `new Date()` calls, which strengthens I3 rather than
   endangering it. That is the best cost/benefit tranche in CH-26 and it is
   available under every option, so it should be done first regardless.
2. **The cost of (b)/(c) is a permanent obligation, not a build.** DATA-ONLY is
   not one control; it is a categorical argument — the payload is inert,
   therefore no control is needed. Replacing it means owning a set of controls
   that must each stay green forever, in the most exposed process we run.
3. **Cordis is the wrong shape of answer.** It would be a serious candidate for
   the *lifecycle* problem if we already had a safe execution story. We do not,
   and it does not provide one.

**Switching criteria — what forces an executable option:** name **one concrete
strategy** a framework needs that (a) cannot express — a parser for a format we
do not parse, an estimator with real arithmetic, a renderer we do not have. Not
"a framework might one day want to compute": one methodId, one behaviour. If
that exists, go to **(b) plus containment sized by authorship**: first-party
only → signing, pinning, provenance, worker-thread isolation; third-party ever →
an isolate or a separate process, and nothing weaker described as if it were
equivalent. (c) enters only if plugin *lifetimes* become genuinely complex —
overlapping, interdependent, hot-swapped — and only on top of a settled
execution model, never as one.

**Migration path if an executable option is retained:** scoped registration plus
owner-aware revocation through the existing `disabled` channel; mocks to data
first; frameworks last, one at a time, and only after G1's provenance and replay
tests are green on a real framework end to end; the runtime plugs at the ARCH-27
seam and `pnpm check:boundaries` stays on an **empty** baseline — a new entry is
a request to reopen ARCH-27. Details in
[plugin-runtime-security.md](plugin-runtime-security.md) § 6.

**The arbitration, 2026-08-28 — the four § 7 questions, answered:**

| Question ([plugin-runtime-security.md](plugin-runtime-security.md) § 7) | Answer |
| --- | --- |
| Who may author a plugin? | **First-party only today. Third parties one day.** |
| Which deployment must support hot plugins? | **HTTP only.** |
| What does "framework plugin" mean for EDGY / Cynefin / BPMN? | Genuinely new computation — **but no concrete methodId could be named.** |
| Is a signing key operationally acceptable? | **Overkill while the payload is inert.** |

**What decided (a): the switching criterion was applied and not met.** This ADR
asks for *one* methodId a DATA-ONLY bundle cannot express — a parser for a format
we do not parse, an estimator with real arithmetic, a renderer we do not have.
None could be named on 2026-08-28. The class claim ("a framework will want to
compute one day") is the argument this ADR pre-emptively refuses, because it
would buy a permanent obligation with an intuition. **Answer 3 therefore does not
trigger (b); it is recorded so the next attempt starts from a named requirement.**

**What "HTTP only" buys, immediately: T1 is dead.** No arbitrary execution
reaching the machine of a stdio user, whose trust boundary *is* the spawning
process. This is free and holds by a one-line guard, independent of everything
else here.

**What "third parties one day" fixes: the containment ceiling, not a roadmap.**
Per this ADR's own rule — *containment is set by who may author, not by what a
plugin does* — first-party-only sizes at signing, pinning, provenance and
worker-thread isolation; third-party sizes at a V8 isolate or a separate process.
**The second is not an increment of the first.** The day a third party may
publish, ARCH-29 reopens whole; it does not get amended.

**Acceptance elements — what a reader or a test can check:**

- **A1** Status is accepted, option (a). Options (b) and (c) are refused *for
  now*, on the record, with the criterion that would revive them.
- **A2** G2 is permanent under (a), not conditional on the 🔴 status — see the
  correction above.
- **A3** stdio never loads a bundle. Guard to add; T1 stays impossible by
  construction rather than by deployment habit.
- **A4** `manifest.permissions` is **deleted**, not enforced. This ADR requires
  one or the other whatever is chosen; under (a) nothing executes, so an
  unenforced permission enum is pure misdirection and goes.
- **A5** `signature?: string` is reserved in the manifest schema — optional,
  unverified, uncommented as a control. The schema is `.strict()`, so a field
  added later would be rejected by every daemon deployed until then; reserving it
  costs one line and removes a future breaking change. Signing itself stays out:
  the trust anchor today is the `service_role`-write-only row plus per-file
  sha256, not a key.
- **A6** The mocks-to-data tranche is unblocked and needs no further arbitration.
- **G1 is dormant, not satisfied.** Under (a) there is no plugin activation to
  trace, so provenance and replay-refusal are **prerequisites of any future
  (b)** — not follow-ups to this decision. `ArtifactBody` still carries no
  `codeProvenance` and `PipelineEvent` still has no lifecycle phase; both stay
  survivable exactly as long as the code is the binary.

**Consequences (of recording it, whatever is arbitrated):**

- **The DATA-ONLY rule stops being folklore.** It was one comment line in a
  schema file. It is now four named threats with the code paths that make them
  impossible today — so a future PR that weakens it has to argue against
  something.
- **Two invariants are documented as red before CH-26 touches them.** Artefacts
  carry no code provenance and `PipelineEvent` has no lifecycle phase. Both are
  survivable while the code is the binary; both are prerequisites, not
  follow-ups, the moment it is not.
- **`manifest.permissions` is on the record as unenforced.** Whatever is
  decided, it must be enforced or removed. It will not be quietly inherited.
- **The mocks-to-data tranche is unblocked.** It needs no arbitration, improves
  determinism, and deletes an env flag. It is the CH-26 work that can start
  while the human reads this.

---

## ARCH-30 — One contract, N liaisons: `agentReply` is the first, and every next one goes through `AgentAdapter`

**Status:** ❌ **Rejected — product arbitration 2026-08-26 (see ARCH-31).** The implementation was reverted from the integration branch the same day it landed (PR #63 stays as the record). The rejection is not a verdict on the execution — it is a boundary decision: labre-mcp never writes labre business state. Originally recorded as: ✅ Applied for the labre-mcp half — human arbitration C3, 2026-08-25 ("un contrat, N liaisons : `AgentAdapter` reste l'unique contrat ; les liaisons s'ajoutent quand un besoin les paie ; première liaison à payer : `agent.reply`"). Executed by chantier **CH-25** (AI-harness audit, wave 4). Builds on **ARCH-27** (the façade — this is a delivery-layer addition that touches neither `src/core/` nor `src/transport/`) and consumes five labre ADRs: **ADR-0026** (the AgentAdapter contract), **ADR-0021** (read scope + write floor), **ADR-0027** (quotas, the refusal-as-status rule), **ADR-0028** and its 2026-07-18 amendment (agent registration, the personal-LLM pivot), **ADR-0032** (tokens, the hosted-daemon budget gate).

**🔴 The labre half is red zone and it is ALREADY PAID.** Everything this liaison calls — `claim_agent_turn`, `insert_agent_message`, `record_agent_spend`, `release_conversation_turn` — exists in labre's migration chain, `SECURITY DEFINER`, granted to `authenticated`, with the gates ADR-0028 specified. CH-25 adds **no migration, no RPC and no grant**. That is the finding, not a shortcut: the red-zone work was done by PR-A4-1 and PR-A4-6 and has been waiting for a caller ever since. The audit's phrase for it — "4 ADRs, zéro code" — describes a socket, not a hole.

**Context:**

Two things existed and did not meet.

On labre's side, `packages/ai-api` publishes the `AgentAdapter` contract (ADR-0026 Decision 2): `createSession` / `sendTurn` / `cancel`, a normalized four-kind event vocabulary, and the explicit promise that "nothing downstream knows which agent produced the events". The [A1] slice wired labre's own in-app AI behind it and extracted the ingestion point. Then the database grew the whole external-agent surface — the single-flight claim an agent turn shares with the in-app AI, the message RPC that hard-codes the actor and reads the conducting `agent_id` off the claim row, the ledger insert that attributes spend to the agent's owner, the mandatory quiesce on release. The header of the first of those migrations says it plainly: *"There is no caller yet (the labre-mcp adapter + daemon slice wires them next); this is the data layer only."*

On labre-mcp's side, that slice was never written. The audit verified it: **no `agent-reply.tool` anywhere in `src/`**. `reply.ts` remained the only living implementation of the contract, and labre's published language had exactly zero consumers outside the repository that published it. A contract with one implementation is a class with a long name.

What made the gap easy to leave open is that the ADRs talk about it in two voices. ADR-0027 Decision 4 describes `assertAgentQuota` and `agent-turn.mts` as if they were code someone could read; ADR-0028's `agent_id_required` migration says a first-class `'agent-required'` status "shipped alongside this migration". Neither ever existed here. Reading those ADRs as a description of the code is how one ends up re-deriving a design that was already arbitrated — so CH-25 read them as a **specification** and implemented it.

**The confusion this ADR has to clear first:**

ADR-0028's amendment of 2026-07-18 is emphatic — **"Decision A — the turn runs through `reply.ts`, never the daemon"** — and its slice B4 retires the daemon's per-turn provider backend. Taken as a slogan, that forbids this liaison. Taken as what it says, it does not, and the distinction is the whole design:

| | ADR-0028's retired path | This liaison |
| --- | --- | --- |
| Who triggers | a human's browser, on `@handle` | the MCP caller itself |
| Whose brain answers | an LLM provider the owner registered | **the caller's own** — no provider is called |
| What labre-mcp does | fetch a provider secret, call a model | relay a finished turn |
| What labre-mcp spends | the owner's provider account | nothing |
| Why it was wrong / is right | *"we conflated adding an external endpoint with connecting an MCP server"* | the caller **is** an MCP client; there is nothing to conflate |

The amendment retired the daemon as a **detour**: a browser reaching a JSON-RPC service to have it call an HTTP endpoint `reply.ts` could call directly, buying a second deployment, a second env var and a silent no-op when it was unset. Here the daemon is not a detour, it is the door the caller already came through. And the credential that made the retired path delicate — `get_agent_provider_config`, the owner's provider key — **is not read here and must never be**: this liaison calls no model, so it needs no model's secret.

**Decision 1 — The liaison is an MCP tool, and it goes through the contract:**

`agentReply` conducts **one bounded turn** of a labre conversation. It is not an HTTP client of `reply.ts` and it is not a second turn engine: it instantiates an `AgentAdapter`, calls `createSession` + `sendTurn`, and feeds the normalized events to one ingestion routine. Every labre write is an RPC the database gates.

The wire name is **`agentReply`, not `agent.reply`**. Hard rule #24b forbids a dot — one invalid tool name makes claude.ai reject every request of any conversation that includes the connector. `agentReply` is also what labre's own client calls it (ADR-0028 Decision 5), so the ADRs' `agent.reply` is the concept and this is the identifier.

- _Rejected — an HTTP call to `api/conversations/reply.ts`:_ it would make labre-mcp a proxy for a function whose contract is the browser's, re-derive the claim/ingest/release dance outside the contract, and give the C3 arbitration nothing to hold. The point of "one contract, N liaisons" is that the second liaison costs an adapter, not an integration.
- _Rejected — a bare `insert_agent_message` call with no claim:_ the RPC refuses it (fail-closed: no active external-agent claim, no message), and it would skip the mutual exclusion that keeps one conversation to one running turn.

**Decision 2 — The brain is the caller: `CallerSuppliedAdapter`:**

Every other implementation of this contract owns a model. This one owns none. The agent at the other end of the MCP connection has already thought; its turn arrives as the tool's arguments, and `sendTurn` replays it into the normalized vocabulary — prose, then each proposal, then `turn-end` with usage.

That is not a degenerate adapter, it is what the contract was shaped for. ADR-0026 Decision 2 left `AgentTurnInput.prompt` open with the words *"an adapter whose turn is prompt-driven rather than reading the persisted thread carries it here"*, and the normalization exists precisely so the ingestion point does not care who produced the events. The dividend is concrete: **labre-mcp holds no LLM credential on this path, spends nothing, and cannot leak a provider secret it never reads.**

`capabilities` are `{ streaming: false, interrupt: false }`, honestly: there is nothing to stream (the payload is complete on arrival) and nothing to interrupt (no call is in flight). `cancel` is a genuine idempotent no-op; ADR-0026 Decision 5's "no orphan turn" is honoured by the claim TTL and the orchestrator's release, not by that method.

**Decision 3 — Identity is the caller's, and a `lab_` key is refused WITH A REASON:**

The caller was authenticated at the daemon door. This tool mints nothing, stores nothing, and reads only which bearer that was, through the same transport-scoped `AsyncLocalStorage` the cost ledger already uses. Every call to labre goes out under **that** JWT plus the public anon key — the posture of `supabase-bundle-source.mts` and `ledger-report.mts`. **labre-mcp holds no privileged Supabase credential on this path or any other, and this ADR does not open one.**

A `lab_` personal API key is refused with the first-class status `identity-unsupported` and one sentence explaining why. ADR-0026 Decision 4 states the mechanism: a `lab_` key is not a JWT, `validate_api_key` resolves it to a bare `user_id` and mints no token, so `auth.uid()` is null and every RPC this turn needs is blind. That ADR's path 2 designs the key-authenticated DEFINER RPC family that would serve those callers; ADR-0028 moved it to Future work and it does not exist. Refusing loudly is the only honest option — the alternative is the failure mode the [A2] recette classed MAJOR: a 100% invisible non-reply.

The write posture is **hard-coded and taken from no input**: `scope: 'restricted'`, `writeMode: 'ask'` — ADR-0026 Decision 3's external-agent floor, *"regardless of the conversation's `ai_write_mode`: a guest brain does not inherit the owner's auto"*. ADR-0028's amendment (Decision B) lifts a **personal LLM** off that floor on the argument that the owner registered it and holds its key. An MCP client is not that, so the floor stands here.

**Decision 4 — Quota at `sendTurn`, refusal as a status, and the claim taken later:**

ADR-0026 Decision 4 puts the gate "at `sendTurn`, daemon-side, keyed on `user_id`"; ADR-0027 Decision 4 makes a refusal a **result status, never a JSON-RPC error** — *"the orchestrator's contract is 'never throws for expected outcomes'"*. Both hold: the guard is `lib/llm/quota-guard.mts`, the existing hosted-daemon budget check of ADR-0032 Decision 2, and an exhausted budget comes back as `status: 'quota-exceeded'` carrying `used` / `limit`.

One deliberate improvement on ADR-0027's own sketch. That sketch claimed the turn first, then released through the **bare-delete path** (`p_reason` NULL) specifically so a refused turn would not append a `turn.quiesced` it never earned. Guarding **before** the claim makes the special case disappear: nothing is claimed, so there is nothing to release and no event to suppress. The invariant it protected — "a denied turn never started, so the log must not say it ended" — is satisfied more simply. The database's own in-transaction per-agent cap (`agent_turn_quota_ok`, inside `claim_agent_turn`) is untouched and still binds.

Because `claim_agent_turn` answers a bare boolean that can mean four different things, two of them are read first under the caller's own JWT and named: `agent-revoked` (the `agents` row, member-readable) and `agent-not-invited` (`conversation_agent_shares`, member-readable). What is left is genuinely `busy`. **Those reads are advisory**: they grant nothing, and if they fail the turn proceeds to the claim, which is the gate that decides. The published vocabulary is `replied` · `quota-exceeded` · `agent-revoked` · `agent-not-invited` · `busy` · `identity-unsupported` · `not-configured` · `error`, and the tool's own description lists it so a calling agent can branch on it.

ADR-0028's `'agent-required'` status is **not** in that list, and that is a recorded deviation: the wire schema makes `agentId` mandatory, so an omitted agent is a schema rejection rather than a turn outcome. The status existed because the parameter was once optional; the anonymous path is retired at both ends now.

- _Rejected — surfacing a quota refusal as a JSON-RPC error:_ ADR-0027's own rejection, reused verbatim. A quota refusal is an expected outcome, not a degradation.
- _Rejected — reusing `'degraded'`:_ that status invites a retry; a quota refusal must not.

**Decision 5 — The contract is VENDORED, and the copy is guarded in two tiers:**

`@labre/ai-api` is `"private": true` with a single source-first export (`"." : "./src/index.ts"`). So an npm dependency is impossible; a `file:`/workspace link would tie a **published** package — one whose lib mode must build with no sibling checkout — to `../labre` being on disk; and a re-declaration from memory would be a second contract drifting silently, the exact thing a published language exists to prevent. Vendoring is the only shape left, and it is only defensible with a mechanical check:

- **Tier 1 — always bites, CI included.** The vendored surface is pinned by value: the event vocabulary, the error taxonomy, the 36-verb command allow-list and its size, plus a compile-time proof that the interface is implementable as written. This proves the copy is **stable**.
- **Tier 2 — bites harder when `../labre` is reachable.** The upstream source is read, CRLF-normalised, hashed against the recorded provenance, and its `commandSchemas` keys are diffed against the allow-list. This proves the copy is **true**. It skips when the sibling checkout is absent — and **prints that it skipped**, because a green tick meaning "I checked nothing" is a pattern this audit has already found elsewhere in this codebase and does not intend to reproduce.

Refreshing the contract = update the copy, run the test with `../labre` present, update `UPSTREAM_SHA256`, commit both together.

**Two narrowings, recorded rather than hidden:**

1. **`AiCommand` is carried opaquely** (`{ type, params? }`) instead of vendoring the 750-line command catalogue. labre-mcp is a conduit for a proposal, never its executor: under ask mode a human's client applies the command, and **that client is the validator**. What the conduit does enforce is the **verb**, against the vendored allow-list — enough to keep an unknown command out of a persisted message (it would render as a dead button in someone's thread), without vendoring a catalogue that moves weekly. A rejected verb is reported back in the result, never dropped in silence.
2. **Query verbs are not vendored at all.** A query is something an agent asks labre to READ for it mid-round, and this liaison does not read — see below.

**Decision 6 — The C3 guard: every next liaison goes through `AgentAdapter`:**

The arbitration's second clause is a rule, and this is where it is written down:

> **Any future way for labre-mcp to act inside a labre conversation is an `AgentAdapter` implementation plus an ingestion path — never a bespoke client of a labre endpoint, and never a second turn engine.** A liaison is added when a need pays for it; the contract is not re-opened when it is.

Concretely: a liaison that needed to call a model would be another adapter, not a branch inside this one; a liaison that reads the thread is a separate tool with its own authorization story (below), not an extra field here. A PR that reaches labre by any other shape is a request to re-open this ADR, in the same way a new entry in `import-boundaries-baseline.json` is a request to re-open ARCH-27.

**Where the line runs:**

Delivered, green, on stubs: the tool and its wire schema, the adapter, the pure ingestion, the PostgREST door, the orchestration with all eight statuses, the two-tier parity guard, the parity-matrix row, and the tool-list baselines on both wires.

Deliberately NOT in this liaison, each with its reason:

- **Reading the thread.** To answer, the caller needs context — and it gets it out of band today (a human summoned it, pointing at the conversation). A labre-mcp read surface must resolve ADR-0021's `full`/`restricted` scope, and **no code resolves that scope anywhere yet**; inventing a resolution here would be exactly the "don't re-arbitrate what an ADR settled" trap. This is the natural **second liaison to pay**, and it is a bigger question than it looks: it is the inbound family ADR-0028 parked in Future work.
- **Streaming and presence** (ADR-0026 Decisions 4/5): no cross-session PubSub, and the Realtime presence join is a browser-adjacent mechanism the daemon has never had.
- **`agent-always` routing** (ADR-0028 Decision 5): a labre-side responder selection; nothing about it belongs on this wire.
- **Provider secrets** (`get_agent_provider_config`): not read, by design — see Decision 2.
- **An end-to-end round against a live labre stack.** The liaison is proved against stubs, and the RPC argument shapes are read off the live migration bodies (including the CH-19 change that made `p_session_id` **text**). What no stub can prove is that a real PostgREST answers those five calls as expected under a real JWT. That recette is the first thing to run at review, and it is named here rather than implied by a green tick.

**Two honesty notes about metering**, because the numbers deserve to be read correctly:

1. **Usage is caller-asserted.** labre-mcp did not make the call and cannot measure it. The ledger row is written through the **existing** agent path (`record_agent_spend`, `source='external-agent'`, attributed to the agent's owner through the claim) — no second ledger, per ADR-0028 Decision 6 — and its model label falls back to the honest string `external-agent` rather than an invented name.
2. **Consequently, neither token meter binds this turn.** The per-agent daily cap is token-denominated since ADR-0032 Decision 1, so a caller declaring no usage never fills it; and `get_my_ai_usage` sums only `agent_id IS NULL` rows, which an agent row is not. That is **coherent, not a hole**: labre pays nothing for a turn thought by the caller's own brain, and ADR-0032's rule is "labre does not refuse you for spend labre never made". What still binds is the guard at `sendTurn` — reaching labre through the hosted daemon at all is what ADR-0032 Decision 2 gates, and at AI launch that gate becomes the plan gate by itself.

**Consequences:**

- **labre's published language finally has a second consumer**, which is the only way a contract gets tested as a contract. The parity guard is what turns "we copied it" into "we can prove it is the same".
- **The MCP surface gains a tool that runs no strategy.** `agentReply` is the first entry in the registry that is a liaison rather than a capability, and the first that can refuse for an authorization reason. Both facts are visible in its status vocabulary rather than buried in an error string.
- **It is advertised on both wires.** A stdio caller reaching it gets `identity-unsupported` with a sentence — worth more than a tool that mysteriously does not exist on one transport.
- **ARCH-27 is untouched and stays green.** The liaison lives in `src/lib/agent/` (no tool named) and `src/mcp/agent-reply.tool.mts` (the descriptor); `check:boundaries` stays at zero and the lib-mode graph never reaches it.
- **The labre side needs a human, not a migration.** No schema changes, but the liaison exercises auth-bearing DEFINER RPCs across a product boundary for the first time — mandatory review, and the live-stack recette above is its acceptance test.

---

## ARCH-31 — labre-mcp is a dead end: it writes its accounting, never labre's business state

**Status:** ✅ **Accepted — product arbitration by the human, 2026-08-26.** Supersedes the liaison half of ARCH-30 (rejected above) and AMENDS the C3 arbitration of 2026-08-25: the `AgentAdapter` contract remains labre's single definition of "acting inside a conversation", but **no liaison of that contract will ever live in this repository**.

**Context:**

CH-25 built `agentReply` — an MCP tool through which an external harness conducted a turn of a labre conversation. The execution was disciplined (caller's own JWT, no privileged credential, refusals as statuses) and it revealed that labre's red-zone sockets had been waiting since July. It was reverted anyway, because making the capability concrete made the boundary question concrete, and the product owner arbitrated it:

> labre-mcp is the most stateless possible and is a **dead end** ("une impasse"). An external harness consumes it for its framework knowledge and competences — and comes back out with a result. The labre app consumes it the same way. **Labre assistant stays in control of the conversation.**

Two facts made the rejection principled rather than aesthetic:

1. **The agnosticism invariant.** This repository is a framework-knowledge shell "agnostic to the visualisation tool" (product clarification, 2026-08-25). `agentReply` was labre-specific by definition — the proof is that it had to VENDOR labre's conversation contract into this tree. When a repo must embed another product's language to exist, the coupling its own charter forbids has arrived.
2. **C3's own condition.** "Liaisons are added when a need pays for them" — and no need had paid for `agentReply`: no external harness asked to write, the app did not consume it. What a need HAS paid for is the opposite flow: metering.

**Decision — the dead-end rule, stated exactly:**

1. **Business state: never.** labre-mcp holds no code path that writes labre's business state — conversations, messages, maps, turns, claims. Not under the caller's JWT, not under any key. A future "external agent writes into a conversation" capability, if a need ever pays for it, is a **labre surface** (labre's own API / the planned `@labre/*` MCP mount point), consuming labre's contract at home, vendored nowhere.
2. **Accounting state: yes, and owed.** labre-mcp DOES write its own metering into labre's Postgres — `ai_calls` rows, quota checks, `lab_` API-key management. labre is this daemon's administration and billing plane (there is deliberately no separate console): the tokens a client burns through the MCP are tokens that client pays for, and they must be tracked. The known gap — `lab_`-keyed and stdio calls leaving NO ledger row — is therefore a defect to close, not a documented tolerance to keep.
3. **The July sockets stay dormant, documented.** labre's `claim_agent_turn` / `insert_agent_message` / `release_conversation_turn` RPCs (granted to `authenticated`, no caller) are labre's property and a labre decision: kept dormant for a possible labre-owned door, or revoked by a labre red-zone migration the day the use case is definitively closed. Nothing in this repository calls them.

**Consequences:** the CH-25 commits are reverted from the integration branch (PR #63 remains as the record and the recipe for a future labre-owned door). The "second liaison" (thread reading from here) dies with the first. The successor slice is the metering one: attribute `lab_`-keyed spend to the key's owner via a definer RPC, so the dead end pays its bills.

**Follow-through — the `lab_` half of the gap is closed (2026-08-26).** labre's red-zone migration `20260826170716_record_mcp_key_spend.sql` adds `labre_mcp.record_mcp_key_spend`, a `SECURITY DEFINER` RPC granted to `anon` — the same door and the same access model as `validate_api_key`, which this daemon's auth middleware already calls with the public anon key. It resolves the key through `validate_api_key` itself (one hashing site, no copy), applies the OWNER's hourly budget on `get_my_ai_usage`'s exact window and entitlement chain, and inserts the `ai_calls` row attributed to that owner with `source = 'mcp'`. Here, `lib/llm/ledger-report.mts` routes a `lab_` bearer to it instead of skipping the write, and a `denied` is memoised on the key so the caller's next run is refused before it spends — a refusal carried as a status, never as an opaque error (ADR-0027 Decision 4). No privileged credential is added on this side: the daemon still authenticates as `anon` and the key travels memory → RPC, never a log line.

**The stdio half is NOT closed, and that is the honest answer, not a deferral.** stdio has no auth middleware, reads no key from the environment, and sets no ledger identity (`mcp/labre-stdio.mts`, `transport/stdio-server.mts`) — there is no identity to meter, and inventing one (an env-var key, a machine id) would be forging an account rather than reading one. A local stdio run also spends the USER's own provider keys through their own `llm.config.json`: it costs labre nothing, so there is nothing for labre to bill. **stdio local sans clé = non compté, assumé.** If stdio ever gains a `lab_` identity, the same reporter path meters it with no change: the routing is on the bearer's shape, not on the wire.
