# Recipes

> Cross-references: [ADR-06](decisions.md#arch-06--recipes-are-tool-scoped) (tool-scoped), [ADR-07](decisions.md#arch-07--recipes-are-not-parameterisable) (no parameters), [ADR-08](decisions.md#arch-08--recipes-follow-a-shipped--override-pattern) (shipped+override), [ADR-10](decisions.md#arch-10--event-bus-is-rxjs-in-process-async-by-default) (event bus).

## Model

A recipe is a declarative, quasi-linear DAG of strategy invocations operating on a single tool's AST. Recipes are JSON files validated by [`RecipeSchema`](../../src/core/recipe/recipe.schema.mts):

```json
{
  "schemaVersion": "1.0",
  "name": "evaluate-map",
  "domain": "wardley",
  "tool": "map",
  "description": "...",
  "steps": [
    { "stepId": "parse-map", "tool": "render:wardley-map:owm:parse:dsl", "in": "$.input", "out": "$.chain" },
    { "stepId": "estimate-all", "tool": "wardley:map:climate:position-functional-in-evolution:llm-direct", "over": "$.chain.result.components", "out": "$.evaluations" }
  ],
  "listeners": {}
}
```

`listeners` is a **map keyed by `stepId`** — each key maps to an array of listener methodIds observing that step. Example: `"listeners": { "build": ["wardley:map:value-chain:audit:default"], "place-labels": ["wardley:map:value-chain:audit:overlap-check"] }`. A key must match an existing `steps[].stepId` (validated by the schema).

## Step semantics

Each step has:

- `stepId` — unique within the recipe, used in event traces.
- `tool` — 5-segment methodId resolved against the kernel's strategy registry at run time.
- `in` (optional) — JSONPath into the current AST identifying the step's input. Default: `$` (whole AST).
- `out` (optional) — JSONPath where the step's result is written. Default: `$.lastResult`.
- `over` (optional) — JSONPath identifying an array. When set, the runner fans out the step across the array's elements using `Promise.allSettled` (auto-fanout).

The runner reads/writes the AST in place: each step's output is visible to subsequent steps via JSONPath.

## Auto-fanout

The `over` keyword is the **only** control-flow primitive in the recipe schema. It exists to avoid forcing every strategy to handle both `T` and `T[]` shapes. When a step declares `over: $.components`, the runner:

1. Resolves `$.components` to an array.
2. Calls `strategy.evaluate(item, context)` once per element in parallel.
3. Aggregates results into an array via `Promise.allSettled` (per memory `feedback_parallelize_independent.md` — never `for…of + await`).
4. Writes the array to `out`.

There is no `if`, no `loop`, no `branch`. If conditional logic is needed, that's the signal to encapsulate the logic in a new strategy.

## No parameters (ARCH-07)

Recipes are not parameterisable. Behavioural variation is expressed by attaching different **listener strategies** to the same recipe — listeners observe the event bus and emit insights or alternative analyses without changing the main pipeline. This trades one degree of flexibility (parameter sweeping) for a cleaner model (no recipe-as-program).

## Tool-scoped (ARCH-06)

A recipe operates on a single tool's AST. To compose across tools (e.g. parse a chain, then analyse its components for evolution, then re-annotate the chain), the orchestration happens at the **skill** level: one skill invokes multiple recipes in sequence and stitches results.

A recipe never invokes another recipe. No sub-recipes.

## Listeners

A recipe declares opt-in listeners as a **map `stepId → [methodId]`**. Each listener observes its parent step.

**Execution contract** (implemented in [`recipe-runner.mts`](../../src/core/recipe/recipe-runner.mts)): listeners do **not** run inline after their step. The main path runs all steps `1..N` first; then, once the run completes, **every** listener (across all steps) is launched **together, in parallel** (`Promise.allSettled`). Each listener receives its parent step's business result (the value at `<step.out>.result`, symmetric with how downstream steps consume `$.x.result`) and contributes only to the JSON-labre envelope: its `signals`/`reasoning`/`insights` are folded into `envelope`, plus a `trace` entry attributed to the parent step. A listener failure is **isolated** — it never affects the main path or the returned AST (ARCH-10).

Two categories of listener:

- **Core** — always active, non-disablable. Defined in `src/core/listeners/`. Examples: `degradation-tracker`, `artifact-writer`, `notification-emitter`. These subscribe to the event bus.
- **Opt-in** — declared in the recipe's `listeners` map, keyed by parent `stepId`. They run as described above (post-run, parallel, envelope-only). Examples: `wardley:iteration:purpose:audit-purpose-quality:default`, `wardley:map:value-chain:read:pipeline-opportunity`.

Limit (V1): opt-in listeners do not emit bus events and cannot inject new steps into the running recipe. They only observe their parent step's output and emit insights into the envelope. Reactive intervention is V3+.

## Shipped + user override + bundles (ARCH-08)

Recipes are resolved by [`recipe-loader.mts`](../../src/core/recipe/recipe-loader.mts) in three ranked sources:

1. **User override** — `<projectRoot>/recipes/<framework>/<tool>/<name>.recipe.json` (if `projectRoot` is supplied in context).
2. **Registered bundle recipe** — in-memory, populated by `registerBundle` (local dir or the remote Supabase source). A bundle may never shadow a shipped recipe (collision rejected at registration), so ranks 2 and 3 never overlap.
3. **Shipped** — `<shippedRoot>/recipes/<framework>/<tool>/<name>.recipe.json` (the labre-mcp install root).

There is no field-level merge — recipes are integral declarations. A bundle recipe additionally carries the bundle's **prompt overrides**, applied only to runs of that exact recipe through a run-scoped store (a same-ref user recipe never inherits them) — see [remote-admin-contracts](../technical/remote-admin-contracts.md).

## Canonical recipes (V1 shipped)

| Recipe | Domain:Tool | Purpose |
|---|---|---|
| `generate` | wardley:map | NL → value chain → laid out → emitted OWM (4 steps) |
| `estimate-component-evolution` | wardley:map | Position with `llm-direct` + `identify` (primary path), then a once-per-run `property-assessment` **listener** on `identify` (envelope-only) (2 steps + listener) |
| `evaluate-map` | wardley:map | Parse map → fan out per-component `llm-direct` positioning + `identify` capability (scatter, envelope-only) (3 steps) |
| `draw-value-chain` | wardley:map | NL → value chain, **readability X only, no evolution** → SVG (5 steps) |
| `estimate-chain-components` | wardley:map | `select-by-type:component` (anchors excluded) → fan out per-component `llm-direct` positioning → annotations, no render (2 steps) |

Each shipped recipe is validated against `RecipeSchema` by [`shipped-recipes-validation.test.mts`](../../src/core/recipe/shipped-recipes-validation.test.mts) — schema drift causes test failure before runtime.

> **A recipe must orchestrate more than one command.** A recipe whose only value is wrapping a single strategy is redundant with a direct call: invoke the methodId via the `runCommand` MCP tool instead (it returns the same JSON-labre envelope). A 1-step recipe is only justified when it carries a `listeners[]` that adds out-of-path insight. The former single-step recipes `parse` and `anchor-estimate` were removed in favour of `runCommand` (`render:wardley-map:owm:parse:dsl`, `wardley:map:climate:position-anchor-in-evolution:culture-phase`).

## Authoring a new recipe

1. Pick `name`, `domain`, `tool` so the resulting file lands at `recipes/<domain>/<tool>/<name>.recipe.json`.
2. List `steps` referencing existing strategy methodIds in the registry.
3. Keep the DAG quasi-linear; use `over` for fan-out; avoid the urge to add control flow.
4. Run `npm test -- src/core/recipe/shipped-recipes-validation.test.mts` to confirm schema validity.
