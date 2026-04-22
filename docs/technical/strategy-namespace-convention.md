# Strategy namespace convention

## TL;DR

Every strategy registered by an auto-discovery registry exposes a `method`
identifier in the form:

```
<mode>:<family>:<strategy>
```

Examples in this repo today:

| Location | `method` |
|---|---|
| `src/work-on-evolution/write/strategies/capacity/s-curve-strategy.mts` | `write:capacity:s-curve` |
| `src/work-on-evolution/write/strategies/capacity/publication-analysis-strategy.mts` | `write:capacity:publication-analysis` |
| `src/work-on-evolution/write/strategies/capacity/timeline-benchmark-strategy.mts` | `write:capacity:timeline-benchmark` |
| `src/work-on-evolution/write/strategies/capacity/llm-direct-strategy.mts` | `write:capacity:llm-direct` |
| `src/work-on-evolution/write/strategies/capacity/logprob-distribution-strategy.mts` | `write:capacity:logprob-distribution` |
| `src/work-on-evolution/write/strategies/capacity/cpc-evolution-strategy.mts` | `write:capacity:cpc-evolution` |
| `src/work-on-evolution/write/strategies/solution/properties-strategy.mts` | `write:solution:properties` |

## The three segments

### `<mode>` — `read` / `write` / `analyze`

Describes the relationship between the strategy's **input** and its **output**
target parameter.

- **`write`** — the target parameter is NOT provided in the input, the
  strategy invents it (e.g. "estimate evolution from a component name").
- **`read`** — the target parameter IS provided in the input, the strategy
  corrects / raffines / validates it (e.g. "given a component with an
  evolution position, produce a refinement or explanation of discrepancies").
- **`analyze`** (not yet implemented) — produce a free-text analysis that is
  not meant to be programmatically consumed.

Today every strategy in `work-on-evolution/` is `write:*` — no `read:*` or
`analyze:*` strategy exists yet, but the slots are materialized
(`work-on-evolution/read/`, `work-on-value-chain/{read,write}/…/`) so new
strategies can be dropped in without any boilerplate.

### `<family>` — the codomain the strategy operates on

In `work-on-evolution/`:

- `capacity` — strategies that evaluate a capability component (activity,
  practice, knowledge, or data) on the evolution axis.
- `solution` — strategies that evaluate a named solution against the 12
  Wardley phase-reference properties.
- `anchor` — strategies that position an anchor (user + need) using the
  perception lens. The current anchor pipeline is standalone (no registry),
  so it has no explicit namespaced method yet.

In `work-on-value-chain/`:

- `anchor` — invent / refine the anchor of a value chain.
- `component` — invent / refine a component's label, type, or capability.
- `chain` — invent / refine the value chain itself (components + needs).

### `<strategy>` — the strategy's own identifier

Lowercase, hyphen-separated, meaningful short name (e.g. `s-curve`,
`publication-analysis`, `timeline-benchmark`).

## What this namespace is NOT

There are three orthogonal identifier spaces in this project. They may happen
to overlap textually for some entries but they are NOT required to stay in
sync:

| Identifier space | Example | Where it lives | What consumes it |
|---|---|---|---|
| Strategy **`method`** | `write:capacity:s-curve` | `static get method()` of strategy class | Registry (`getStrategy`), `evaluations[method]` |
| **LLM role ID** | `publication-analysis` | `src/lib/llm/strategy-ids.mts`, `llm.config.example.json` | `getStrategyLLM()` to pick the LLM backend for a role |
| **Prompt ID** | `publication-analysis` | `prompts.config.json` | `getPrompt(id)` to resolve a prompt template |

When renaming a strategy's `method` (C5 of the 2026-04-22 read/write
refactor), we intentionally did NOT rename the LLM role IDs or the prompt
IDs. They remain flat (`publication-analysis`, `cpc-evolution`,
`logprob-distribution`, …) because:

- Prompts are semantic resources — they outlive the strategy that happens
  to consume them.
- LLM role IDs are configuration keys owned by the operator, not tied to the
  internal strategy hierarchy.

## How the registry enforces this

Each family has its own auto-discovering registry:

```
src/work-on-evolution/write/strategies/capacity/registry.mts
src/work-on-evolution/write/strategies/solution/registry.mts
src/work-on-evolution/read/registry.mts
src/work-on-value-chain/{read,write}/anchor/registry.mts
src/work-on-value-chain/{read,write}/component/registry.mts
src/work-on-value-chain/{read,write}/chain/registry.mts
```

Each registry scans its sibling directory for `*-strategy.{mjs,mts}` files,
imports each one, and registers any exported class whose prototype extends
that family's `BaseXxxStrategy`. Strategies with a non-falsy `static get
disabled()` are moved to the disabled map and excluded from
`loadStrategies()`.

## Adding a new strategy

1. Pick the right directory based on `mode × family`.
2. Create a file named `<something>-strategy.mts`.
3. Export a class extending the family's base strategy.
4. Set `static get method()` to return `"<mode>:<family>:<strategy>"`.
5. Implement the required evaluation method (`evaluate`, `identify`,
   `build`, or `refine` depending on the family's contract).

No other file needs to be edited — the registry picks it up automatically.

## Skill-handler aliases (conversational)

The conversational skill-handler in
`src/work-on-evolution/write/skill-handler.mts` keeps a table of
human-friendly aliases (e.g. `scurve`, `pub-analysis`, `timeline`,
`benchmark`, `llm`, `direct`, `logprob`) that all resolve to the canonical
namespaced `method` at parse time. This affects only the free-text / skill
entry point; programmatic callers of `estimateEvolutionOneShot()` must use
the full namespaced value.
