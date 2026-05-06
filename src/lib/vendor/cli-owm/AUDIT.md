# AUDIT.md — cli-owm vendoring (Phase 0)

## Pinned version
- Commit SHA: 4950f330095e6505f8534f852812457da3fa1c32
- Commit date: 2026-04-15
- Audited on: 2026-05-06

## Verdict
**GO** — safe to vendor for V1.

## Sinks scan (~3000 LOC across 31 files)
- No `eval`, `new Function`, `Function(`
- No `child_process`, `spawn`, `exec`, `fork`
- No `fs.*`, `readFile`, `writeFile`
- No `http`, `https`, `net`, `dgram`, `tls`, `ws`, `fetch`, `XMLHttpRequest`
- No dynamic `import()` or `require()` with variables
- No `process.env`, `process.exit`, `process.argv`, `process.cwd`
- One static SVG namespace literal `http://www.w3.org/2000/svg` in render.mts (not a network call)

## Obfuscation scan
- No long encoded strings except one SVG path glyph (visually verifiable)
- No `String.fromCharCode`, `atob`, `btoa`, `Buffer.from(..., 'base64')`
- No unicode escape packs

## Dependencies
- Declared runtime: `lodash.merge ^4.6.2` (official lodash org)
- Used in code: `lodash.merge` (single import in `parser/extractionFunctions.mts`), all other imports relative
- No undeclared imports
- No pre/post install lifecycle scripts

## `lodash.merge` prototype-pollution call site review
The single merge call uses only hardcoded keys (`decorators`, `increaseLabelSpacing`, `market`, `build`, `buy`, `outsource`, `ecosystem`). No DSL-derived keys reach the merge target. **Not exposed.**

## Parser provenance cross-check
- `UnifiedConverter` and `AnchorExtractionStrategy` are verbatim copies of their counterparts in `damonsk/onlinewardleymaps` (MIT, ~300 stars), modulo trivial path-rewrite diffs reflecting cli-owm's flatter folder layout. No logic changes.

## Git history
- 20 commits, linear, no force-pushes.
- 2 contributors: Chris Gough (monkeypants, 17 commits) + dependabot (3 commits, version bumps).
- Author has security awareness (`SECURITY.md` + GPLv2-or-later license commit + rollup CVE override commit).

## Residual risks accepted for V1
- Bus factor 1, 0 stars: trust is in the audited code, not the publisher.
- GPL-2.0-or-later imposes copyleft; accepted by the project for V1.
- Vendored verbatim → no passive security updates. Re-audit on every future bump.

## Recommendation
Proceed to wrapper layer (Phase 2). Re-audit on any version bump.
