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

2. **Implementation provenance becomes part of the catalogue.** `StrategyRegistry.registerMock()` is a second registration verb with identical behaviour and one added fact. A harness must be able to tell a deterministic scaffold from a real computation **before** it spends a call trusting the answer, and `mock` was previously knowable only from a class-name prefix — a naming convention, not a contract. Provenance is now declared at the composition root that knows it (`src/frameworks/mocks-registry.mts`), so promoting a mock means deleting its line there, which is exactly what flips the catalogue.

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
