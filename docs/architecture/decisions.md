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

**Consequences:** RxJS becomes a kernel dependency. Listener strategies subscribe via `eventBus.subscribe(filter)` returning `AsyncIterable<PipelineEvent>`. The interface stays stable so V2 persistence (DuckDB sink) is a non-breaking addition.

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

**Status:** Accepted

**Context:** The current MCP server runs per-project via stdio. This conflicts with using the Claude Agent SDK (which spawns sub-processes that collide with active Claude Code sessions). It also makes the trajectory to a hosted multi-tenant service expensive (different transport, different state model).

**Decision:** labre-mcp runs as a locally-installed daemon, exposing MCP over HTTP on localhost (default port 6767). Transport choice intentionally aligns with V3 SaaS: same protocol, different host + auth.

**Consequences:** All tool calls become self-contained (no implicit `cwd`). The Agent SDK is usable inside the daemon (no Claude Code session conflict). Auth is a no-op middleware in V1, real in V3 (see ARCH-15). Existing stdio support is dropped in CP10.

---

## ARCH-15 — `process.cwd()` forbidden at runtime; context propagated explicitly

**Status:** Accepted

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

**Status:** Deferred — the `AnalysisRefSchema` was drafted in V1 but never written at runtime; it was removed in the post-v0.1.0 cleanup along with `WardleyChainAST` and `WardleyEvolutionAST`. The structured-pointer shape will be recreated when the recipe runner needs to cross-reference detailed analyses from chain components (currently `envelope.references[]` carries the same intent but is unused).

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
- `JSON-labre` is the canonical artefact shape: a métier sub-tree per `wardley.*` aspect (conformant to its tool schema, the renderer schema in the case of `wardley.map`) plus a transverse `envelope` carrying `context`, `signals`, `reasoning`, `insights`, `trace`, `references` (cf. ARCH-22 + ARCH-24).
- ADRs are still append-only and immutable; the supersession is marked via the `Status:` header of each impacted ADR. The original decision text is preserved as historical context.
- The `StrategyMetadata.status` enum in [ast-schema.md § 3.4.3](ast-schema.md) includes the value `"mock"` to mark scaffolded I/O contracts that have no real implementation yet. Mock strategies live under `src/frameworks/**/*.mock-strategy.mts` and are registered via `registerMocks(registry)` after the real strategies at daemon boot, so the MCP catalogue exposes the full v0.1.0 surface from day 1.
