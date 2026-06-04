# Purpose of this code base

labre-mcp is an MCP (Model Context Protocol) server that helps the user apply practice frameworks — Wardley Maps first, climates / doctrines / gameplays / cycle next. The targeted horizon for the Wardley framework is the full strategic study cycle (9 phases: prompt → chain → evolution → climates → invest → doctrine → orientation → strategy → close). The server exposes MCP tools backed by a pluggable registry of strategies orchestrated by the kernel recipe runner.

> **V1 status — kernel posed, post-audit refactor in progress.** Architectural decisions are recorded as ADRs in [docs/architecture/decisions.md](/labre-mcp/docs/architecture/decisions.md) (ARCH-01 to ARCH-25). Strategy classes for Wardley currently live under `src/frameworks/wardley/{chain,evolution}/_legacy/` per ARCH-23 (in-place migration). Physical extraction to the canonical `<tool>/<command>/<subdomain>/` layout is scheduled for V1.5 cleanup. Until then, both the new core `StrategyRegistry` and the legacy `loadStrategies()` filesystem walker resolve to the same classes. The repository directory will eventually be renamed `labre-mcp` (the npm package name and `.mcp.json` server name are already aligned). **Current surface:** the daemon wires **1 business MCP tool** (`estimateEvolution`) + `__ping__`, and registers **85 strategies (15 real / 70 mock)**. The full gap to the target is tracked in [roadmap.md](/labre-mcp/docs/architecture/roadmap.md).


# Architecture

Read these first if you're new to the project:

- [ast-schema.md](/labre-mcp/docs/architecture/ast-schema.md) — **pivot grammar** (5-segment methodIds, open command vocabulary, JSON-labre artefact, strategy contract). Authoritative: supersedes/amends several ADRs (ARCH-25).
- [decisions.md](/labre-mcp/docs/architecture/decisions.md) — 25 ADRs (ARCH-01..25) that ground every other decision
- [roadmap.md](/labre-mcp/docs/architecture/roadmap.md) — what is **not yet** done (lib/→core, `_legacy/` extraction, tool wiring, mocks→real). Read this to avoid coding against a structure that does not exist yet.
- [strategies.md](/labre-mcp/docs/architecture/strategies.md) — registry, BaseStrategy contract, result format with signals/reasoning/insights
- [recipes.md](/labre-mcp/docs/architecture/recipes.md) — recipe schema, listeners, auto-fanout, shipped+override loader
- [transport.md](/labre-mcp/docs/architecture/transport.md) — HTTP daemon on localhost, context propagation, auth middleware
- [persistence.md](/labre-mcp/docs/architecture/persistence.md) — artefact JSON files in `~/.labre-mcp/runs/`, project identity

## High-level shape (current)

> Describes the code **as it is today**. The remaining migration to the canonical target is tracked in [roadmap.md](/labre-mcp/docs/architecture/roadmap.md); the detailed `src/` tree lives in [tree-map.md](/labre-mcp/docs/technical/tree-map.md).

```
labre-mcp/
├── src/
│   ├── core/                  # KERNEL — survives across frameworks
│   │   ├── registry/      strategy-registry                          (ARCH-03)
│   │   ├── recipe/        recipe-runner, recipe.schema, recipe-loader (ARCH-06/07/08)
│   │   ├── bus/           event-bus (RxJS Subject)                   (ARCH-10)
│   │   ├── ast/           base-strategy                              (ARCH-22)
│   │   ├── context/       request-context                            (ARCH-15)
│   │   ├── transport/     labre-daemon, http-server, mcp-handler, auth (ARCH-14)
│   │   ├── listeners/     artifact-writer-listener (core)            (ARCH-12)
│   │   └── persistence/   artifact-writer, project-id                (ARCH-12)
│   │
│   ├── lib/                   # cross-cutting utils — NOT yet under core/ (roadmap B1)
│   │   └── llm/  prompts/  owm/  degradation/  patent/  vendor/  zod/
│   │
│   ├── frameworks/
│   │   ├── wardley/{map,chain,evolution,climate,doctrine,gameplay,iteration,…}
│   │   │   └── …/_legacy/   real strategies still live here          (ARCH-23, roadmap B2)
│   │   ├── common/           cross-framework strategies              (ARCH-25)
│   │   ├── render/           OWM + image rendering
│   │   └── mocks-registry.mts  registers the 70 mock strategies
│   │
│   ├── mcp/                   estimate-evolution.tool.mts (the one wired MCP tool, roadmap B3)
│   └── schemas/  types/  session/  tests/
│
├── recipes/                   # shipped canonical recipes (ARCH-08)
│   ├── wardley/map/*.recipe.json
│   └── render/wardley-map/parse.recipe.json
│
└── docs/architecture/         # ADRs (decisions.md) · pivot (ast-schema.md) · roadmap.md
```


# Hard rules

## Language

1. All comments are in english (inline, block, JSDoc)
2. All documentation is in english
3. All variables are in english
4. All commit messages (subject + body) are in english
5. Conversations with the assistant stay in the user's preferred language

## TypeScript

6. Use `.mts` (never `.ts`) for ESM strict modules; scripts run via `tsx`, production compiles to `.mjs`
7. Strict typing by default. `any` / `unknown` require a `// any: <reason>` comment justifying the escape hatch
8. Zod schemas are the single source of truth for runtime contracts

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

18. MCP handlers go through `withMcpDegradation`; external calls (LLM, BigQuery, disk) go through `tryDegradeAmbient`; health checks run at boot
19. Under Windows, MCP servers launched via `npx` need a `cmd /c` wrapper in `.mcp.json` or they fail to start
20. **`process.cwd()` forbidden at runtime** (ARCH-15) — every tool call carries `context.{projectId, projectRoot, sessionId, domain}`. Reading `process.cwd()` or `process.env.X` outside the daemon boot (top-level config loading) is forbidden

## Naming

21. Strategy methodIds follow the 5-segment pattern `{domain}:{tool}:{sub-domain}:{command}:{strategy}[@version]` — the pivot [ast-schema.md](/labre-mcp/docs/architecture/ast-schema.md) is authoritative (ARCH-03 amended by ARCH-25; note segments 3 and 4 are sub-domain **then** command). Example: `wardley:map:climate:position-functional-in-evolution:s-curve`. `:default` is a canonical strategy at segment 5, never implicit on the wire.
22. The command vocabulary (segment 4) is **open**, not a fixed set: `generate, parse, emit, audit, identify, estimate, update, …` (ARCH-04 superseded by ARCH-25). `update` is a valid standalone command (write-gateway `wardley:map:output:update:default`)
23. `context` (business environment, user-supplied only) and `description` (component label, MCP may enrich) are distinct — never fall back from one to the other
24. Use generic Wardley phase keys `phase1..phase4` for distributions, never `wonder/build/operate/usage` or `genesis/custom/product/commodity` (semantic contamination)

## Strategy result format (ARCH-22)

25. Every strategy returns `{ signals[], reasoning[], insights[], result }` — never just a raw value. LLM reasoning traces are captured, not discarded. See [strategies.md](/labre-mcp/docs/architecture/strategies.md)

## Recipes (ARCH-06, 07, 08)

26. Recipes are tool-scoped — cross-tool flows orchestrated at skill level, not in recipes
27. Recipes are not parameterisable — behavioural variation comes from listener strategies attached to the same recipe
28. Recipes follow shipped + user override pattern: `<repo>/recipes/<framework>/<tool>/<name>.recipe.json` + `<projectRoot>/recipes/...`. User wins by name; no field-level merge
29. The only control-flow primitive in recipes is `over: $.path` (auto-fanout). No `if`, no `loop`. If you need control flow, write a strategy

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
