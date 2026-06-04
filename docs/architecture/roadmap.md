# Roadmap — migration en cours

> **Rôle de ce document.** Le reste de la documentation décrit le code **tel qu'il est aujourd'hui**. Cette page est le **backlog unique** des chantiers de migration non terminés : l'écart entre l'état courant et la cible architecturale (AGENT.md + [ast-schema.md](ast-schema.md)). Quand un doc dit « non encore câblé » ou « encore sous `_legacy/` », il renvoie ici.
>
> Source de vérité de l'état courant : le daemon imprime au boot la liste des outils et des stratégies enregistrés (stderr) ; `LABRE_DISABLE_MOCKS=1` isole les stratégies réelles.

## État courant en une ligne

Daemon HTTP `src/core/transport/labre-daemon.mts` (:6767) — **1 outil MCP métier câblé** (`estimateEvolution`) + `__ping__` — **85 stratégies** enregistrées dont **15 réelles** et **70 mocks** — kernel sous `src/core/`, utilitaires encore sous `src/lib/`, stratégies réelles encore sous `_legacy/`.

## Chantiers (Famille B)

### B1 — Consolidation du kernel : `src/lib/` → `src/core/`

- **Cible (AGENT.md § High-level shape)** : `llm/`, `prompts/`, `owm/`, `degradation/` vivent sous `src/core/`.
- **Aujourd'hui** : toujours sous `src/lib/` (`llm`, `prompts`, `owm`, `degradation`, `patent`, `vendor`, `zod`), importés via les alias `#lib/*`.
- **Action** : déplacer dossier par dossier, mettre à jour les alias `package.json#imports` et les imports, build vert à chaque étape. `patent/`, `vendor/`, `zod/` : décider cible (core/ vs lib/ conservé) au cas par cas.

### B2 — Extraction `_legacy/` → layout canonique

- **Cible** : `src/frameworks/<domain>/<tool>/<command>/<subdomain>/` (ARCH-23).
- **Aujourd'hui** : ~38 fichiers source réels (toutes les stratégies réelles : s-curve, llm-direct, top-down, identify-capability, properties, anchor…) encore sous `…/_legacy/`. Le registry réel et le walker `loadStrategies()` legacy résolvent vers les mêmes classes.
- **Action** : extraction physique « V1.5 cleanup » (ARCH-23). Retirer ensuite les alias transitoires `#work-on-evolution/*` et `#work-on-value-chain/*` du `package.json`.

### B3 — Surface d'outils MCP : 1 → N câblés

- **Cible** : la surface complète du cycle d'étude exposée comme outils/recipes.
- **Aujourd'hui** : `buildBootRegistry()` n'enregistre que `__ping__` + `estimateEvolution`. Les flux `evaluateMap`, `identifyCapability`, `estimateAnchorEvolution`, `generateValueChain` existent comme **recipes** (`recipes/wardley/map/*.recipe.json`) + stratégies, mais ne sont **pas exposés** comme outils MCP.
- **Action** : décider l'API d'exposition (un outil générique `runRecipe` / `runCommand` piloté par methodId, vs un outil par flux) puis câbler dans `buildBootRegistry()`.

### B4 — Promotion des mocks → stratégies réelles

- **Cible** : catalogue [ast-schema.md](ast-schema.md) § 1.2 entièrement réel.
- **Aujourd'hui** : 70 mocks (`src/frameworks/**/*.mock-strategy.mts`, enregistrés via `registerMocks`) vs 15 réelles. La liste des 15 réelles fait foi dans [ast-schema.md → « État d'implémentation »](ast-schema.md).
- **Action** : implémenter les stratégies prioritaires, basculer leur `StrategyMetadata.status` de `mock` à `experimental`, mettre à jour la liste « État d'implémentation » de l'AST.

### B5 — Unification de version

- **Aujourd'hui** : `package.json` = `1.0.0`, daemon/`/version` = `1.0.0-migration`, [ast-schema.md](ast-schema.md) = `v0.1.0`.
- **Action** : choisir une source de vérité de version (probablement `package.json`) et l'aligner partout (daemon `SERVER_INFO`, `/version`, AST).

### B6 — Préoccupations transverses déclarées mais non câblées

Le framework existe sous `src/lib/`, mais aucun appelant ne l'active dans le chemin de dispatch du daemon — alors qu'AGENT.md les pose comme invariants :

- **Dégradation** (hard rule #18) : `withMcpDegradation` / `tryDegradeAmbient` (`src/lib/degradation/`) n'ont aucun appelant de production ; `mcp-handler.dispatch` n'enveloppe pas les handlers. **Action** : envelopper le dispatch et les appels externes.
- **Health-checks au boot** : `registerHealthCheck` n'a aucun appelant de production (pas de `boot-health-checks`). **Action** : enregistrer les health-checks (bigquery, llm:*, web-search) au boot du daemon.
- **Capability `claude/channel`** : `SERVER_CAPABILITIES` ne déclare que `{ tools: {} }` ; les notifications channel (`src/lib/mcp-notifications.mts`) ne sont pas annoncées dans `initialize`. **Action** : déclarer la capability si les notifications chat doivent être visibles côté client.

### B7 — Outillage d'évaluation (promptfoo)

- **Aujourd'hui** : `promptfooconfig.yaml` référence `file://scripts/s-curve-transform.js` et `file://scripts/claude-eval.mjs`, or le dossier `scripts/` n'existe plus (la logique s-curve vit sous `src/frameworks/wardley/evolution/_legacy/write/s-curve/`).
- **Action** : repointer la config promptfoo vers les chemins réels ou restaurer les scripts.

## Backlog équipe (P1 / P2 — hors passe documentaire)

Identifiés lors de l'audit qualité, à traiter dans des passes dédiées :

- **P1 — Garde-fous d'équipe** : CI (typecheck + tests unitaires sûrs sur PR), séparation tests unitaires / tests appelant un vrai LLM, linter/formatter (Biome), `CONTRIBUTING.md`.
- **P2 — Dette** : finir B1/B2, câbler B3, passe de réduction des `any`/`unknown` justifiés (≈364 hors tests) une fois les schémas Zod stabilisés.
