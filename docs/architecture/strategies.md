# Strategies

> This doc covers the **registry, the BaseStrategy contract, and the StrategyResult shape**.
> The methodId **grammar** (segments, command vocabulary, version) is owned by the pivot
> [ast-schema.md](ast-schema.md) — authoritative. See also [ADR-22](decisions.md#arch-22--strategy-result-format--signals-reasoning-insights-result) (result format), [ADR-25](decisions.md).
> The catalogue of business strategies (real vs mock) lives in [../functional/strategies.md](../functional/strategies.md).

## Identity

Every strategy is identified by the 5-segment methodId defined in [ast-schema.md](ast-schema.md):

```
domain:tool:sous-domaine:command:strategie[@x.y.z]
```

Note the order: **sub-domain then command** (segments 3 and 4). The command vocabulary is **open**
(`generate, parse, emit, audit, identify, estimate, update, …`), not a fixed four-command set
(ARCH-04 superseded by ARCH-25). `:default` is a canonical strategy at segment 5, never implicit.

**Real examples** (registry surface):

```
wardley:map:value-chain:generate:top-down                     — generate a value chain (top-down)
render:wardley-map:owm:parse:dsl                              — parse OWM DSL → JSON-labre
render:wardley-map:owm:emit:dsl                               — serialise JSON-labre → OWM DSL
wardley:map:climate:position-functional-in-evolution:s-curve — evolution from certitude+ubiquity
wardley:map:climate:position-functional-in-evolution:llm-direct — evolution via direct LLM reasoning
wardley:map:node:identify:default                            — decode component → underlying capability
wardley:map:value-chain:prevent-collision:default            — place labels deterministically
wardley:map:value-chain:audit:overlap-check                  — detect 2D overlaps
```

### Regex shape

Each segment matches `[a-z][a-z0-9-]*`; the full id (with optional SemVer suffix) matches:

```
^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*){4}(@\d+\.\d+\.\d+)?$
```

Exported as `methodIdSchema` (Zod) from [`src/core/ast/base-strategy.mts`](../../src/core/ast/base-strategy.mts). Every AST schema that stores a methodId (`RecipeStep.tool`, listener ids, reasoning/insight `by`) reuses it, so invalid IDs fail validation before any strategy runs.

## Registry

The kernel exposes a generic [`StrategyRegistry`](../../src/core/registry/strategy-registry.mts) keyed by methodId. Each framework exposes a `register*Strategies(registry)` function (e.g. [`registerEvolutionStrategies`](../../src/frameworks/wardley/evolution/registry.mts), [`registerChainStrategies`](../../src/frameworks/wardley/chain/registry.mts)) that explicitly registers its strategy classes. The daemon's [`buildStrategyRegistry`](../../src/core/transport/labre-daemon.mts) wires them all together at boot.

The registry validates methodIds at registration time via `validateMethodId()`, which reuses the same regex. Invalid IDs throw before any strategy can be invoked.

## Base contract

Every strategy extends [`BaseStrategy<TInput, TResult>`](../../src/core/ast/base-strategy.mts):

```ts
abstract class BaseStrategy<TInput, TResult> {
  static get method(): string;                         // 5-segment ID — overridden by subclass
  abstract evaluate(input: TInput, context: RequestContext): Promise<StrategyResult<TResult>>;
}
```

The return type is non-negotiable: every strategy produces the four-part `StrategyResult` shape (ARCH-22):

```ts
interface StrategyResult<TResult> {
  signals: Array<{ name, value, source, capturedAt }>;       // typed inputs that fed the analysis
  reasoning: Array<{ by, text, promptTokens?, completionTokens? }>;  // LLM trace — never thrown away
  insights: Array<{ text, by, type, confidence? }>;           // higher-level interpretation
  result: TResult;                                            // canonical structured output
}
```

This is the single biggest hygiene change from the previous codebase: where strategies used to return only `{ evolution, confidence, method }`, they now capture the entire reasoning chain so that V2 cross-run analytics has rich material to work with.

## Command semantics

The command (segment 4) is an **open vocabulary** (ast-schema.md). Common families and the shape of their `result`:

- **`parse` / `identify`** — turn external input into an AST node (OWM parser, capability identifier).
- **`generate` / `update`** — produce or enrich AST content. `update` is a valid standalone command (write-gateway `wardley:map:output:update:default`).
- **`audit`** — validates, scores, detects anomalies. `result` is observational (no AST mutation).
- **`emit`** — serialises an AST to an external format (OWM, image, markdown). `result` is typically a string with metadata.

Multi-command flows are composition, expressed as recipes (see [recipes.md](recipes.md)). A **single** strategy is invoked directly by methodId via the `runCommand` MCP tool (it runs the command as a degenerate 1-step recipe and returns a `CommandResult` with the JSON-labre envelope) — no recipe needed. See [tools-reference.md](../functional/tools-reference.md#runcommand).

## Adding a new strategy

1. Pick the 5-segment methodId (ast-schema.md grammar).
2. Create the strategy file. The canonical target layout is `src/frameworks/<domain>/<tool>/<command>/<subdomain>/<name>-strategy.mts`; today the real strategies still live under `…/_legacy/` pending extraction (roadmap B2) — follow the surrounding convention of the framework you extend.
3. Extend `BaseStrategy<TInput, TResult>` and override `static get method()`.
4. Implement `evaluate(input, context)` returning `StrategyResult<TResult>`.
5. Register it in the framework's `register*Strategies(registry)` function (e.g. `src/frameworks/wardley/evolution/registry.mts`). For a scaffold, use a `*.mock-strategy.mts` registered via `registerMocks` (see [extending.md](../technical/extending.md)).

Do not omit `signals`, `reasoning`, or `insights` — pass empty arrays if a strategy genuinely has no entries for a category, but capture what is meaningful.

## Versioning

SemVer `@x.y.z` is adopted from v0.1.0 (per-AST and per-strategy), amending ARCH-20. When omitted on the wire, the latest stable version resolves. See [ast-schema.md § 3.2](ast-schema.md) for the bump/resolution policy.
