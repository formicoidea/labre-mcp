# Strategies

> Cross-references: [ADR-03](decisions.md#arch-03--strategy-identity-uses-5-segments) (5-segment IDs), [ADR-04](decisions.md#arch-04--four-commands-read-write-quality-emit) (4 commands), [ADR-22](decisions.md#arch-22--strategy-result-format--signals-reasoning-insights-result) (result format).

## Identity

Every strategy in labre-mcp is uniquely identified by a 5-segment methodId:

```
{framework}:{tool}:{command}:{subdomain}:{strategy}[@version]
```

| Segment | Purpose | Examples |
|---|---|---|
| `framework` | Practice domain | `wardley`, `cynefin` (future), `common` (cross-framework) |
| `tool` | Artefact type within a framework | `chain`, `evolution`, `climate` (future), `doctrine` (future), `gameplay` (future), `cycle` (future) |
| `command` | Direction of the operation | `read` (parse external → AST), `write` (produce AST content), `quality` (validate/score), `emit` (serialise AST → format) |
| `subdomain` | Part of the AST being acted on | `map`, `component`, `anchor`, `layout`, `dsl`, `cross-step`, … |
| `strategy` | Named algorithm | `s-curve`, `top-down`, `place-labels`, `overlap-check`, … |
| `@version` | Optional version tag | `@latest` (implicit default), `@1.2`, `@2.0` |

**Examples**:

```
wardley:chain:write:map:top-down               — generate a chain map from NL command
wardley:chain:read:map:owm-parser              — parse OWM DSL → WardleyChainAST
wardley:chain:emit:owm:standard                — serialise chain AST → OWM DSL
wardley:evolution:write:capacity:s-curve       — estimate evolution from certitude+ubiquity
wardley:evolution:write:capacity:llm-direct    — estimate evolution via direct LLM reasoning
wardley:evolution:read:component:identify-capability — decode component → underlying capability
common:layout:write:labels:default             — cross-framework: place labels deterministically
common:layout:quality:overlaps:default         — cross-framework: detect 2D overlaps
```

### Regex shape

Each segment matches `[a-z][a-z0-9-]*` (lowercase letter then lowercase alphanumeric or dash). The full id matches:

```
^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*){4}$
```

Exported as `METHOD_ID_5_SEGMENT_REGEX` and `methodIdSchema` (Zod) from [`src/core/ast/base-strategy.mts`](../../src/core/ast/base-strategy.mts). Every AST schema that stores a methodId reuses this — `EvolutionResult.method`, `EvolutionReasoning.by`, `EvolutionInsight.by`, `EvolutionAnnotation.method`, `EvolutionConsensus.{contributingStrategies, divergence[].strategy}`, `RecipeStep.tool`, `Recipe.listeners[]`. Invalid IDs fail validation before any strategy runs.

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

## The four commands in practice

- **`read`** — turns external input into AST. Examples: OWM parser, component classifier, capability identifier. Their `result` is typically a partial or full AST node.
- **`write`** — produces or enriches AST content. Includes placement (placing labels is writing layout coordinates). Their `result` mutates or replaces a sub-tree of the AST.
- **`quality`** — validates, scores, detects cross-step anomalies. Often subscribes to the event bus rather than running as a step. Their `result` is observational (no AST mutation).
- **`emit`** — serialises an AST to an external format (OWM, Mermaid, SVG, markdown report). Their `result` is typically a string (with attached metadata).

No `update` command exists — updates are composition (read + write + emit), expressed as recipes (see [recipes.md](recipes.md)).

## Adding a new strategy

1. Pick the 5-segment methodId.
2. Create `src/frameworks/<framework>/<tool>/<command>/<subdomain>/<name>-strategy.mts`.
3. Extend `BaseStrategy<TInput, TResult>` and override `static get method()`.
4. Implement `evaluate(input, context)` returning `StrategyResult<TResult>`.
5. Register it in the framework's `register*Strategies(registry)` function (e.g. `src/frameworks/wardley/evolution/registry.mts`).

Do not omit `signals`, `reasoning`, or `insights` — pass empty arrays if a strategy genuinely has no entries for a category, but capture what is meaningful. The cost is one extra field in the response; the benefit compounds across runs.

## Versioning (V1.5+)

ARCH-20 defers `@vN` versioning. V1 omits the version segment entirely. When the first behaviour-breaking strategy change arises, we introduce `@v1`, `@v2`, with `@latest` resolving to the most recent.
