# Purpose of this code base

labre-mcp helps the user apply practice frameworks — Wardley Maps first, climates / doctrines / gameplays / cycle next. The targeted horizon for the Wardley framework is the full strategic study cycle (9 phases: prompt → chain → evolution → climates → invest → doctrine → orientation → strategy → close). It is a **kernel with deliveries**: a pluggable registry of strategies orchestrated by a recipe runner, served today over MCP (HTTP daemon + stdio) and embeddable directly as a library.

> **MCP is a DELIVERY, not the identity (ARCH-27, applied 2026-08-26).** The repository is three layers and the dependency points one way — **delivery → transport → kernel**: `src/mcp/` (tool descriptors + the two composition roots) → `src/transport/` (HTTP daemon, stdio server, JSON-RPC dispatch, auth doors) → `src/core/` + `src/frameworks/` + `src/lib/` (registry, recipe runner, bus, contracts, strategies). The kernel names no wire and no tool; the transport names no tool. Two mechanical guards hold it: `pnpm check:boundaries` (baseline **must stay empty**) and `src/lib-mode.test.mts` (the lib entry's import graph must reach neither `src/transport/` nor `src/mcp/`).

> **The MCP surface is TOOLS + COSTUME (ARCH-28, applied 2026-08-26).** Besides the six executable tools the daemon serves **prompts** (the method — six Wardley prompts handed over as text a third-party harness can run on its own model) and **resources** (the knowledge — grammar, live methodId catalogue with real/mock status, shipped recipes, published JSON Schemas) under the `labre://` URI scheme. Both are composed in `src/mcp/` from kernel data catalogues and are **DATA-ONLY**: nothing executable is loaded at run time, no resource takes a parameter. See `pnpm demo:costume`.

> **V1 status — kernel posed, post-audit refactor in progress.** Architectural decisions are recorded as ADRs in [docs/architecture/decisions.md](/labre-mcp/docs/architecture/decisions.md) (ARCH-01 to ARCH-28). Strategy classes for Wardley currently live under `src/frameworks/wardley/{chain,evolution}/_legacy/` per ARCH-23 (in-place migration). Physical extraction to the canonical `<tool>/<command>/<subdomain>/` layout is scheduled for V1.5 cleanup. There is **one** strategy registry — the core `StrategyRegistry`; the parallel `loadStrategies()` filesystem walker under `_legacy/` was retired in CH-18. The repository directory will eventually be renamed `labre-mcp` (the npm package name and `.mcp.json` server name are already aligned). **Current surface:** the daemon wires **6 MCP tools** — `estimateEvolution`, `generateValueChain` (recipe `wardley:map:generate`), `evaluateMap` (recipe `wardley:map:evaluate-map`), `runCommand` (direct invocation of any 5-segment methodId → `CommandResult` + JSON-labre envelope), `runRecipe` (invocation of any multi-step recipe by `<domain>:<tool>:<name>` ref → JSON-labre envelope), and `__ping__` — plus the ARCH-28 costume (**6 prompts, 7 resources**), and registers **86 strategies (25 real / 61 mock, 1 disabled)**. _(Those counts are no longer transcribed: `registerMock` declares provenance at the composition root, and `resources/read labre://methods` computes them — read that resource rather than trusting this line. Real count rises as mocks are promoted; see roadmap B4/B8.)_ The full gap to the target is tracked in [roadmap.md](/labre-mcp/docs/architecture/roadmap.md).


# Architecture

Read these first if you're new to the project:

- [ast-schema.md](/labre-mcp/docs/architecture/ast-schema.md) — **pivot grammar** (5-segment methodIds, open command vocabulary, JSON-labre artefact, strategy contract). Authoritative: supersedes/amends several ADRs (ARCH-25).
- [decisions.md](/labre-mcp/docs/architecture/decisions.md) — 29 ADRs (ARCH-01..29) that ground every other decision. **ARCH-27** (applied 2026-08-26) is the façade: three layers, the four cuts, and what stays at the delivery. **ARCH-28** is the costume: prompts + resources served from kernel catalogues, the prompt selection criterion, the `labre://` URI scheme, and the DATA-ONLY limit that reserves the plugin runtime for C4/CH-26. ARCH-26 settles who owns the `labre_mcp` Postgres schema: the migration chain stays in labre, this repo holds the mechanical schema contract. **ARCH-29 is 🔴 proposed, not decided** — it re-opens the `bundle = DATA-ONLY` security model for the CH-26 plugin runtime and awaits human arbitration; no executable-plugin code may be written before it moves
- [plugin-runtime-security.md](/labre-mcp/docs/architecture/plugin-runtime-security.md) — companion to ARCH-29: what DATA-ONLY protects (four named threats), the three options (rich data / minimal loader / Cordis), containment as an orthogonal axis, and the two guards as testable requirements. **Proposal, not current state**
- [roadmap.md](/labre-mcp/docs/architecture/roadmap.md) — what is **not yet** done (lib/→core, `_legacy/` extraction, tool wiring, mocks→real). Read this to avoid coding against a structure that does not exist yet.
- [strategies.md](/labre-mcp/docs/architecture/strategies.md) — registry, BaseStrategy contract, result format with signals/reasoning/insights
- [recipes.md](/labre-mcp/docs/architecture/recipes.md) — recipe schema, listeners, auto-fanout, shipped+override loader
- [transport.md](/labre-mcp/docs/architecture/transport.md) — HTTP daemon on localhost, context propagation, auth middleware, and the costume's four methods + URI scheme
- [persistence.md](/labre-mcp/docs/architecture/persistence.md) — artefact JSON files in `~/.labre-mcp/runs/`, project identity

## High-level shape (current)

> Describes the code **as it is today**. The remaining migration to the canonical target is tracked in [roadmap.md](/labre-mcp/docs/architecture/roadmap.md); the detailed `src/` tree lives in [tree-map.md](/labre-mcp/docs/technical/tree-map.md).

```
labre-mcp/
├── src/
│   ├── index.mts              # LIB MODE — the kernel's public surface, no server (ARCH-27)
│   │
│   ├── core/                  # KERNEL — survives a change of framework AND of wire
│   │   ├── registry/      strategy-registry (+ catalogue()), tool-registry,
│   │   │                  prompt-registry, resource-registry (the seams) (ARCH-03/27/28)
│   │   ├── catalog/       grammar (5 segments as data), shipped-assets
│   │   │                  (schemas + recipes, enumerable at last)        (ARCH-28)
│   │   ├── recipe/        recipe-runner (+ RunHooks), recipe.schema, recipe-loader (ARCH-06/07/08)
│   │   ├── bus/           event-bus (RxJS Subject)                   (ARCH-10)
│   │   ├── ast/           base-strategy                              (ARCH-22)
│   │   ├── context/       request-context — BUSINESS nature + userId  (ARCH-15/27)
│   │   ├── listeners/     artifact-writer-listener (core)            (ARCH-12)
│   │   ├── persistence/   artifact-writer, project-id                (ARCH-12)
│   │   └── shipped-root.mts   where this package's recipes live
│   │
│   ├── transport/             # THE WIRE — knows the kernel, names nothing (ARCH-14/27/28)
│   │   └── http-daemon, stdio-server, http-server (Hono), mcp-handler (dispatch =
│   │      the auth seam; tools/* + the costume's prompts/* and resources/*),
│   │      auth-context (AUTH nature), auth doors, boot-health-checks,
│   │      boot-posthog, tool-telemetry (mcp_tool_call + mcp_costume_call)
│   │
│   ├── lib/                   # cross-cutting utils — NOT yet under core/ (roadmap B1)
│   │   └── llm/  prompts/  owm/  degradation/  patent/  vendor/  zod/
│   │
│   ├── frameworks/
│   │   ├── registry-boot.mts   buildStrategyRegistry — the frameworks' composition root
│   │   ├── wardley/{map,chain,evolution,climate,doctrine,gameplay,iteration,…}
│   │   │   └── …/_legacy/   real strategies still live here          (ARCH-23, roadmap B2)
│   │   ├── common/           cross-framework strategies              (ARCH-25)
│   │   ├── render/           OWM + image rendering
│   │   └── mocks-registry.mts  registers the mock strategies
│   │
│   ├── mcp/                   # THE DELIVERY — the only layer that names a tool,
│   │   │                      # a prompt or a resource                   (ARCH-27/28)
│   │   ├── labre-daemon.mts / labre-stdio.mts   composition roots (bin + npm scripts)
│   │   ├── tool-registry.mts   buildMcpToolRegistry — the 6 tools
│   │   ├── prompt-registry.mts   the 6 method prompts + THE SELECTION CRITERION
│   │   ├── resource-registry.mts the 7 resources + the labre:// URI scheme
│   │   ├── metering-hooks.mts  labre's quota gate + cost ledger      (ARCH-27, cut 4)
│   │   └── *.tool.mts  *-via-recipe.mts
│   └── schemas/  types/
│
├── recipes/                   # shipped canonical recipes, ≥2 steps (ARCH-08)
│   └── wardley/map/*.recipe.json   # single commands → runCommand tool, not a recipe
│
└── docs/architecture/         # ADRs (decisions.md) · pivot (ast-schema.md) · roadmap.md
```


# Hard rules

## Language

1. All comments are in english (inline, block, JSDoc)
2. All documentation is in english
3. All variables are in english
4. All commit messages (subject + body) are in english
6. All work contents and prompts are in english
5. Conversations with the assistant stay in the user's preferred language

## TypeScript

6. Use `.mts` (never `.ts`) for ESM strict modules; scripts run via `tsx`, production compiles to `.mjs`
7. Strict typing by default. `any` / `unknown` require a `// any: <reason>` comment justifying the escape hatch
8. Zod schemas are the single source of truth for runtime contracts

## Layers (ARCH-27 — the façade)

8b. **The dependency points one way: `src/mcp/` → `src/transport/` → `src/core/`.** The kernel imports neither the transport nor the delivery. The transport imports the kernel but never `src/mcp/`. Enforced by `pnpm check:boundaries`; `scripts/import-boundaries-baseline.json` is empty and **a new entry there is a request to re-open ARCH-27**, not a fix.

8c. **Only `src/mcp/` names a tool, a prompt or a resource.** Composing the MCP surface happens in `src/mcp/tool-registry.mts` (tools) and `src/mcp/{prompt,resource}-registry.mts` (the costume); the transport receives already-filled registries (`HttpDaemonDeps` / `StdioServerDeps`). Adding a delivery = writing another composition root like `src/mcp/labre-daemon.mts`, never editing the wire. The costume proved this costs two lines per root and zero edits to the wire (ARCH-28).

8d. **The kernel never opens a socket and never calls labre's backend.** Metering (quota gate, cost ledger) is installed through `RunHooks` at the delivery seam (`src/mcp/metering-hooks.mts`), never inside the runner. `src/index.mts` is lib mode and its transitive import graph must reach neither `src/transport/` nor `src/mcp/` — `src/lib-mode.test.mts` checks exactly that.

8e. **Auth stops at the dispatch.** `RequestContext` (kernel) carries the business fields plus the minimal `userId`. The credential — role, raw bearer, issuer provenance — lives in `AuthContext` / `AuthenticatedContext` (`src/transport/auth-context.mts`); `dispatch` calls `toBusinessContext` before any handler. Never hand an `AuthenticatedContext` to a tool handler, a listener or a strategy, and never add a credential field to `RequestContext`.

## Tests

9. During refactors run only the targeted unit test files (e.g. `npx tsx --test "src/core/**/*.test.mts"`) — never `npm test` complete (some tests call real LLMs and burn quota / time)
10. Don't replay the mcp end-to-end command just to re-validate something the unit tests already cover (token economy)

## Prompts (ARCH-21 category 2)

11. Prompts are separated from the rest of the /src code
12. Every prompt is a pair `<name>.system.md` (static, zero `{{...}}`) + `<name>.user.md` (variables only) — never a monolithic file. The loader hard-fails if the system file contains a placeholder. The registry's `build()` returns `{ system, user }`; call-sites pass them as `llmCall(built.user, undefined, { systemPrompt: built.system })`, so each provider routes `systemPrompt` to the SDK's native system slot
13. System prompt = semantic LLM configuration (invariant). User prompt = call-specific variables
14. Prompts are strategy-internal (ARCH-21) — they are NOT user-overridable. Recipes and `llm.config.json` are user-overridable.

## Concurrency

15. Any loop over independent operations (strategies, components, signals) uses `Promise.allSettled(items.map(async ...))` — never `for...of + await`. The degradation collector uses `AsyncLocalStorage`, so each async branch keeps its own ambient frame
16. Sequential for-loops are reserved for genuinely dependent iterations
17. Recipe runners auto-fanout array inputs via `over: $.path` in the recipe — see [recipes.md](/labre-mcp/docs/architecture/recipes.md)

## MCP & degradation

18. Degradation is enforced **centrally at the dispatch**: `mcp-handler.dispatch` wraps every tool handler in `withMcpDegradation`, so every `tools/call` response is a `Degradable<T>` (read the business payload at `result.result`) — handlers must NOT self-wrap. External calls (LLM, BigQuery, disk) go through `tryDegradeAmbient` (ambient collector via AsyncLocalStorage). Health checks register + run at boot via `registerBootHealthChecks()` (config/env presence only)
18b. **The costume is DATA (ARCH-28).** A published prompt renders shipped text; a published resource returns a shipped document and its `read()` takes **no argument**. Never make a resource parameterisable and never load executable content at run time — that is C4 / CH-26 and it is not arbitrated. Adding or removing a prompt or a resource means updating the exact baselines in `src/mcp/tool-telemetry-matrix.test.mts`, in both directions: publishing a method or a document to third-party harnesses is a decision, not a side effect. A new prompt must meet the four selection criteria stated in the header of `src/mcp/prompt-registry.mts`.
18c. **A mock declares itself.** Register a scaffold strategy with `registry.registerMock(...)`, never `register(...)`: `labre://methods` reports the `real`/`mock` status a third-party harness reads before it trusts an answer, and that provenance can only come from `src/frameworks/mocks-registry.mts`. Promoting a mock = deleting its line there.
19. Under Windows, MCP servers launched via `npx` need a `cmd /c` wrapper in `.mcp.json` or they fail to start
20. **`process.cwd()` forbidden at runtime** (ARCH-15) — every tool call carries `context.{projectId, projectRoot, sessionId, domain}`. Reading `process.cwd()` or `process.env.X` outside the daemon boot (top-level config loading) is forbidden

## Naming

21. Strategy methodIds follow the 5-segment pattern `{domain}:{tool}:{sub-domain}:{command}:{strategy}[@version]` — the pivot [ast-schema.md](/labre-mcp/docs/architecture/ast-schema.md) is authoritative (ARCH-03 amended by ARCH-25; note segments 3 and 4 are sub-domain **then** command). Example: `wardley:map:climate:position-functional-in-evolution:s-curve`. `:default` is a canonical strategy at segment 5, never implicit on the wire.
22. The command vocabulary (segment 4) is **open**, not a fixed set: `generate, parse, emit, audit, identify, estimate, update, …` (ARCH-04 superseded by ARCH-25). `update` is a valid standalone command (write-gateway `wardley:map:output:update:default`)
23. `context` (business environment, user-supplied only) and `description` (component label, MCP may enrich) are distinct — never fall back from one to the other
24. Use generic Wardley phase keys `phase1..phase4` for distributions, never `wonder/build/operate/usage` or `genesis/custom/product/commodity` (semantic contamination)
24b. MCP tool names are camelCase verb phrases (`estimateEvolution`, `runCommand`, `runRecipe`) and MUST match `^[a-zA-Z0-9_-]{1,64}$` (Anthropic tool-name pattern) — no dots: a single invalid name makes claude.ai reject the whole request of any conversation that includes the connector. **Costume prompt names obey the same charset** — `<strategy>` for a `default` entry, `<strategy>__<name>` otherwise (`write-chain__top-down`). Resource URIs are `labre://<category>[/<id>]`, and a URI names a category, never a version or a path (ARCH-28)

## Strategy result format (ARCH-22)

25. Every strategy returns `{ signals[], reasoning[], insights[], result }` — never just a raw value. LLM reasoning traces are captured, not discarded. See [strategies.md](/labre-mcp/docs/architecture/strategies.md)

## Recipes (ARCH-06, 07, 08)

26. Recipes are tool-scoped — cross-tool flows orchestrated at skill level, not in recipes
27. Recipes are not parameterisable — behavioural variation comes from listener strategies attached to the same recipe
28. Recipes follow shipped + user override pattern: `<repo>/recipes/<framework>/<tool>/<name>.recipe.json` + `<projectRoot>/recipes/...`. User wins by name; no field-level merge
29. The only control-flow primitive in recipes is `over: $.path` (auto-fanout). No `if`, no `loop`. If you need control flow, write a strategy
29b. A recipe must orchestrate **≥ 2 commands** (or 1 command + a value-adding `listeners[]`). A single command is invoked directly via the generic `runCommand` MCP tool — it returns the same JSON-labre envelope. Never ship a single-step recipe with no listener.

## Event bus (ARCH-10)

30. RxJS in-process, async-by-default. Modules emit and observe; no commands flow on the bus
31. Two listener categories: **core** (always active, in `src/core/listeners/`) + **opt-in** (declared per recipe). Core listeners cannot be disabled by config

## Persistence (ARCH-12, ARCH-13)

32. Recipe runs produce verbose, LLM-readable JSON artefacts at `~/.labre-mcp/runs/<projectId>/<runId>.json`. The format is intentionally analytical-ready (V2 DuckDB will query the files directly)
33. Primary memory is the conversation transcript (the harness JSONL), not `memory.md`. labre-mcp neither reads nor writes auto-memory

## Working method

34. Always present a plan before coding non-trivial changes — never jump straight to implementation
35. Plans must be resumable across the 5-hour quota window: split into build-green checkpoints, never leave a half-migration broken
36. Update [/docs/technical/tree-map.md](/labre-mcp/docs/technical/tree-map.md) in the same change as any `src/` reorganisation
37. The migration is big bang, no backwards compatibility (ARCH-16). Each checkpoint leaves a green build; the final cut-over happens in CP10

## LLM providers (ARCH-21 category 1)

38. LLM provider configuration is per-user in `llm.config.json` (template: `llm.config.example.json`). Three providers available: `claude` (Agent SDK), `http-api` (OpenCode gateway, e.g. Kimi with logprobs), `copilot-sdk` (GitHub Copilot)
39. In development the provider should match the tool actively used by the user (e.g. Claude Code → Agent SDK)


# Map around the code base

1. Migration ADRs and architecture topics live in [/docs/architecture/](/labre-mcp/docs/architecture/)
2. Functional and technical docs live in [/docs/technical/](/labre-mcp/docs/technical/) and [/docs/functional/](/labre-mcp/docs/functional/) — realigned on the current code. The remaining migration gap is centralised in [/docs/architecture/roadmap.md](/labre-mcp/docs/architecture/roadmap.md)
3. Plan file: `~/.claude/plans/1-a-2-jolly-octopus.md` (10-checkpoint migration sequence)
4. Strategies, recipes, transport, persistence — each has a dedicated topic doc under `docs/architecture/`
