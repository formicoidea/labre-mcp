# Vendored: cli-owm

- **Source**: https://github.com/monkeypants/cli-owm
- **Commit SHA**: 4950f330095e6505f8534f852812457da3fa1c32
- **Commit date**: 2026-04-15
- **License**: GPL-2.0-or-later (accepted for V1; see project README)
- **Vendored on**: 2026-05-06

## Adaptations applied (verbatim otherwise)

1. File extensions: every `.ts` renamed to `.mts` for ESM strict under our tsx setup.
2. Relative imports: every `from './x'` (or `'../y/z'`) suffixed with `.mjs` per ESM strict requirement. Non-relative imports (e.g. `lodash.merge`) untouched.

No logic changes. No deletions. No additions. If a future bump is needed, re-fetch from the same path structure and re-apply (1) and (2).
