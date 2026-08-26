# Addendum — the chain-geometry tool

This addendum is the ONLY difference between posture B and posture C. The
method above is unchanged; you additionally have the output of one deterministic
tool.

## The tool

```
pnpm exec tsx --conditions labre-mcp-dev bench/geometry/chain-geometry.mts \
  --map <mapKey> --component <componentId>
```

It reads the map's dependency graph and its value-chain heights, and computes,
with no model and no network:

- how many hops down from the user anchor the component sits, out of the depth
  of the whole map;
- how many components consume it, and how many it consumes;
- whether anything sits below it at all (a bottom-of-chain supply);
- whether a user anchor consumes it directly (a user-facing need);
- its height in the value chain, normalised across the map;
- a **positional prior** on the evolution axis: a crude monotone heuristic that
  reads position only, and knows nothing whatsoever about what the component is.

The tool never sees any evolution coordinate — the map it reads does not carry
one. It cannot tell you the answer, only where the component sits.

## How to use it

- Treat the positional prior as ONE piece of evidence among the four in the
  method (ubiquity, certainty, market, perception), not as the answer.
- Where your own reasoning and the prior disagree, say so in one line and
  follow your reasoning: the prior knows nothing about the capability.
- The prior is most useful as a tie-breaker between two adjacent stages, and
  as a warning when your placement is far from where the chain puts the
  component.

The output contract is unchanged: end with `evolution=` then `confidence=`.
