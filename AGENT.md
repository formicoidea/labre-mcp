# Purpose of this code base

WardleyAssistant is an MCP (Model Context Protocol) server that help the user to use the Wardley Maps framework. To set an horizon the targeted full strategic study cycle (9 phases: prompt → chain → evolution → climates → invest → doctrine → orientation → strategy → close). In this optic, it exposes four MCP tools backed by a pluggable registry of strategies. 


# Guidelines to develop in this code base

## Language

1. All comments have to be in english (inline, block, JSDoc)
2. All documentation is in english
3. All variables are in english
4. All commit messages (subject + body) are in english
5. Conversations with the assistant stay in the preferred language of the user

## TypeScript

6. Use `.mts` (never `.ts`) for ESM strict modules; scripts run via `tsx`, MCP server compiles to `.mjs`
7. Strict typing by default. `any` / `unknown` require a `// any: <reason>` comment justifying the escape hatch
8. Zod schemas are the single source of truth for runtime contracts

## Tests

9. Global / integration tests live in [/src/tests](/WardleyAssistant/src/tests/)
10. During refactors run only the targeted unit test files — never `npm test` complete (some tests call real LLMs and burn quota / time)
11. Don't replay the mcp end-to-end command just to re-validate something the unit tests already cover (token economy)

## Prompts

12. Prompts are separated from the rest of the /src code 
13. Every prompt is a pair `<name>.system.md` (static, zero `{{...}}`) + `<name>.user.md` (variables only) — never a monolithic file. The loader hard-fails if the system file contains a placeholder. **How:** the registry's `build()` returns `{ system, user }`; call-sites pass them as `llmCall(built.user, undefined, { systemPrompt: built.system })`, and each provider routes `systemPrompt` to the SDK's native system slot (Anthropic `system`, OpenAI `messages[role:system]`, Copilot `SessionConfig.systemMessage`). **Why:** aligns with the standard system/user role split so providers cache the static part and don't silently concatenate or drop it; keeps invariant LLM configuration cleanly isolated from per-call variables
14. System prompt = semantic LLM configuration (invariant). User prompt = call-specific variables

## Concurrency

15. Any loop over independent operations (strategies, components, signals) uses `Promise.allSettled(items.map(async ...))` — never `for...of + await`. The degradation collector uses `AsyncLocalStorage`, so each async branch keeps its own ambient frame. See `evaluateStrategiesInParallel` in `src/work-on-evolution/write/estimate-evolution.mts` for the canonical helper
16. Sequential for-loops are reserved for genuinely dependent iterations (e.g. capability phase B/C that consume phase A outputs)

## MCP & degradation

17. MCP handlers go through `withMcpDegradation`; external calls (LLM, BigQuery, disk) go through `tryDegradeAmbient`; health checks run at boot
18. Under Windows, MCP servers launched via `npx` need a `cmd /c` wrapper in `.mcp.json` or they fail to start

## Semantics & naming

19. Module classification: `write/` = invented output, `read/` = refined input, `analyze/` = analytical text (future)
20. `context` (business environment, user-supplied only) and `description` (component label, MCP may enrich) are distinct — never fall back from one to the other
21. Use generic Wardley phase keys `phase1..phase4` for distributions, never `wonder/build/operate/usage` or `genesis/custom/product/commodity` (semantic contamination)

## Working method

22. Always present a plan before coding non-trivial changes — never jump straight to implementation
23. Plans must be resumable across the 5-hour quota window: split into build-green checkpoints, never leave a half-migration broken
24. Update [/docs/technical/tree map.md](/WardleyAssistant/docs/technical/tree-map.md) in the same change as any `src/` reorganisation

## LLM providers
25. LLM provider configuration is per-user in `llm.config.json` (template: `llm.config.example.json`). Three providers available: `claude` (Agent SDK), `http-api` (OpenCode gateway, e.g. Kimi with logprobs), `copilot-sdk` (GitHub Copilot)
26. In development phase the provider should be set up to the same provider that is in use for by the user. For example is the user is using claude code then the anthropic agent sdk should be use. 


# Map around the code base

1. Project documentation lives in [/docs](/WardleyAssistant/docs/), split into [technical](/WardleyAssistant/docs/technical/) and [functional](/WardleyAssistant/docs/functional/)
2. Key technical docs:
   - [architecture.md](/WardleyAssistant/docs/technical/architecture.md) — strategies registry, classification gate, dispatch flow, parallelization invariants
   - [tree-map.md](/WardleyAssistant/docs/technical/tree-map.md) — annotated `src/` tree (kept in sync with code reorganisations)
3. Functional docs cover the Wardley study cycle (9 phases) and the MCP tool contracts
