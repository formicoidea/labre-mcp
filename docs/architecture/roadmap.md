# Roadmap — migration en cours

> **Rôle de ce document.** Le reste de la documentation décrit le code **tel qu'il est aujourd'hui**. Cette page est le **backlog unique** des chantiers de migration non terminés : l'écart entre l'état courant et la cible architecturale (AGENT.md + [ast-schema.md](ast-schema.md)). Quand un doc dit « non encore câblé » ou « encore sous `_legacy/` », il renvoie ici.
>
> Source de vérité de l'état courant : le daemon imprime au boot la liste des outils et des stratégies enregistrés (stderr) ; `LABRE_DISABLE_MOCKS=1` isole les stratégies réelles.

## État courant en une ligne

Daemon HTTP `src/core/transport/labre-daemon.mts` (:6767) — **4 outils MCP câblés** (`estimateEvolution`, `runCommand`, `runRecipe`, `__ping__`) — **85 stratégies** enregistrées dont **19 réelles** et **66 mocks** — kernel sous `src/core/`, utilitaires encore sous `src/lib/`, stratégies réelles encore sous `_legacy/`.

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
- **Livré** : l'outil générique **`runCommand`** est câblé — il invoque **n'importe quel methodId** (réel ou mock) directement et renvoie un `CommandResult` portant l'enveloppe JSON-labre (`src/mcp/run-command.tool.mts`, schémas `src/schemas/command.schema.mts`). Toute commande **unique** est donc appelable sans recette. Les recettes mono-commande (`anchor-estimate`, `parse`) ont été supprimées au profit de `runCommand`.
- **Livré (suite)** : l'outil générique **`runRecipe`** est câblé (`src/mcp/run-recipe.tool.mts`) — il invoque **n'importe quelle recette multi-étapes** par référence `<domain>:<tool>:<name>` (shipped + override) et renvoie l'enveloppe JSON-labre + l'AST final + le chemin d'artefact. `buildBootRegistry()` enregistre `__ping__` + `estimateEvolution` + `runCommand` + `runRecipe`. L'**exécution des listeners opt-in** est désormais implémentée dans le runner (`recipe.listeners` : map `stepId → [methodId]`, lancés en fin de run, en parallèle, échecs isolés, insights → enveloppe). Nouvelles recettes shipped : `wardley:map:draw-value-chain` (rendu lisibilité) et `wardley:map:estimate-chain-components` (`select-by-type:component` + fan-out `llm-direct`, annotation-only).
- **Reste à faire** : promouvoir les stratégies mock encore référencées par ces recettes (`purpose:audit-purpose-quality`, `read:pipeline-opportunity`) — voir B4. (`basemap:generate`, `image:emit:svg` sont désormais réelles ; le positionnement « de masse » d'une chaîne est exprimé en recette — `select-by-type:component` + fan-out `llm-direct` — et non plus en stratégie monolithique.) Optionnel : outils dédiés par flux si une UX nommée est souhaitée au-delà du générique `runRecipe`.

### B4 — Promotion des mocks → stratégies réelles

- **Cible** : catalogue [ast-schema.md](ast-schema.md) § 1.2 entièrement réel.
- **Aujourd'hui** : 66 mocks (`src/frameworks/**/*.mock-strategy.mts`, enregistrés via `registerMocks`) vs 19 réelles. La liste des réelles fait foi dans [ast-schema.md → « État d'implémentation »](ast-schema.md). Dernières promotions : `wardley:map:basemap:generate:default`, `render:wardley-map:image:emit:svg`, `wardley:map:value-chain:organized-y-position:default`, et `wardley:map:value-chain:select-by-type:component` (moteur sélecteur : construit le tableau des nœuds `type:'component'` pour fan-out per-composant — le positionnement de masse est une recette, pas une stratégie monolithique).
- **Action** : implémenter les stratégies prioritaires, basculer leur `StrategyMetadata.status` de `mock` à `experimental`, mettre à jour la liste « État d'implémentation » de l'AST.

### B5 — Unification de version

- **Aujourd'hui** : `package.json` = `1.0.0`, daemon/`/version` = `1.0.0-migration`, [ast-schema.md](ast-schema.md) = `v0.1.0`.
- **Action** : choisir une source de vérité de version (probablement `package.json`) et l'aligner partout (daemon `SERVER_INFO`, `/version`, AST).

### B6 — Préoccupations transverses (FAIT)

- **Dégradation** (hard rule #18) — _fait_ : `mcp-handler.dispatch` enveloppe **chaque** handler dans `withMcpDegradation` ; toute réponse `tools/call` est un `Degradable<T>`. Les handlers ne s'auto-wrappent plus.
- **Health-checks au boot** — _fait_ : `registerBootHealthChecks()` (`src/core/transport/boot-health-checks.mts`) enregistre `bigquery` / `llm` / `web-search` (présence config/env, sans réseau) ; le daemon les exécute au boot et logge les dépendances dégradées.
- **Capability `claude/channel`** — _fait_ : `SERVER_CAPABILITIES` déclare `logging: {}` + `experimental: { 'claude/channel': {} }`.
- **Reste (backlog)** : sondes de health-check **live** (réseau) ; router au cas par cas les appels externes des stratégies `_legacy` via `tryDegradeAmbient` (le collector ambient est désormais en place).

### B7 — Outillage d'évaluation (promptfoo)

- **Aujourd'hui** : `promptfooconfig.yaml` référence `file://scripts/s-curve-transform.js` et `file://scripts/claude-eval.mjs`, or le dossier `scripts/` n'existe plus (la logique s-curve vit sous `src/frameworks/wardley/evolution/_legacy/write/s-curve/`).
- **Action** : repointer la config promptfoo vers les chemins réels ou restaurer les scripts.

### B8 — Type d'échange canonique `WardleyMap` (anti-corruption)

- **Problème** : le chaînage output(step N) → input(step N+1) des recettes était **convention-based et runtime-fragile** — JSONPath brut sans contrat, types de stratégies hétérogènes (`PositionedValueChain`, `UnifiedWardleyMap`, `ComponentInput`…), aucun type d'échange commun. Symptômes : `prompt` vs `nlCommand`, recettes shipped `generate`/`evaluate-map` cassées au runtime, aucun test e2e avec vraies stratégies.
- **Livré (R1→R3)** : le type canonique `WardleyMap` est désormais **`===` au schéma Zod du package externe `@formicoidea/wardley-map-renderer`** — `src/schemas/wardley-map.schema.mts` est un **ré-export** du `WardleyMapSchema` du package (plus de schéma fait-main ; champs analytiques → `envelope`, pas dans le map). Le **rendu image** passe par `renderToSVG(map)` **du package**, directement (suppression de `acl/unified.mts` + détour cli-owm/OWM DSL pour le rendu). **Anti-corruption layer** restant : `acl/value-chain.mts` (`WardleyMap ↔ PositionedValueChain`, round-trip testé). Stratégies réalignées : `basemap:generate`, `image:emit:svg`.
- **Dépendance** : aujourd'hui **lien local** `file:../wardley-map-renderer` (dev ; le repo voisin contient des données perso non nettoyées → pas encore publié). Bascule en une ligne vers `@formicoidea/wardley-map-renderer@beta` (GitHub Packages **privé**) une fois publié — `.npmrc` + PAT `read:packages` en `NODE_AUTH_TOKEN` déjà en place.
- **Reste (P4)** : (a) `toOWM` du package est marqué **cassé** en amont → l'export/import OWM repassera par lui une fois corrigé (l'ancien `acl/owm-dsl.mts` a été supprimé). (b) Adoption des stratégies `map` LLM-dépendantes restantes (`value-chain:generate:top-down` règle `prompt`/`nlCommand`, layout…). Le positionnement en évolution d'une chaîne se fait via la recette `estimate-chain-components` (`select-by-type:component` + fan-out `llm-direct`), annotation-only ; un rendu SVG de l'évolution nécessitera une étape de consolidation annotations→map, non encore implémentée. (c) Garde-fou : check d'adjacence statique dans `shipped-recipes-validation` + test e2e des 2 recettes avec vraies stratégies.

## Backlog équipe (P1 / P2 — hors passe documentaire)

Identifiés lors de l'audit qualité, à traiter dans des passes dédiées :

- **P1 — Garde-fous d'équipe** : CI (typecheck + tests unitaires sûrs sur PR), séparation tests unitaires / tests appelant un vrai LLM, linter/formatter (Biome), `CONTRIBUTING.md`.
- **P2 — Dette** : finir B1/B2, câbler B3, passe de réduction des `any`/`unknown` justifiés (≈364 hors tests) une fois les schémas Zod stabilisés.
