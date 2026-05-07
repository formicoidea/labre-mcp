# REPOTREEMAP — Cartographie du repo WardleyAssistant

> Source de vérité pour la navigation dans `src/` et pour la mise à jour des imports.
> Ce fichier est maintenu à la main : le mettre à jour à chaque réorganisation.

## 1. Vue d'ensemble

`WardleyAssistant` est un serveur **MCP** (Model Context Protocol) qui expose 5 outils autour des cartes Wardley :

| Outil MCP | Rôle | Wrapper MCP | Lib métier |
|---|---|---|---|
| `estimateEvolution` | Évalue l'évolution d'un composant (genesis → commodity) via 7 stratégies | `src/mcp/estimate-evolution.tool.mts` | `src/work-on-evolution/write/estimate-evolution.mts` |
| `evaluateMap` | Évalue qualitativement une carte OWM | `src/mcp/evaluate-map.tool.mts` | `src/work-on-evolution/write/evaluate-map/evaluate-map.mts` |
| `identifyCapability` | Identifie capabilities / solutions dans un texte | `src/mcp/identify-capability.tool.mts` | `src/work-on-value-chain/write/component/lib/capability/identify-capability.mts` |
| `estimateAnchorEvolution` | Évolution du composant ancre (user need) | `src/mcp/estimate-anchor-evolution.tool.mts` | `src/work-on-evolution/write/strategies/anchor/estimate-anchor-evolution.mts` |
| `generateValueChain` | Construit une chaîne de valeur Wardley complète (OWM DSL) à partir d'un prompt langage naturel | `src/mcp/generate-value-chain.tool.mts` | `src/work-on-value-chain/write/chain/strategies/top-down/top-down-strategy.mts` |

## 2. Points d'entrée

- **Script npm (dev)** : `package.json` → `"dev": "tsx src/mcp/mcp-server.mts"` (charge les `.mts` via tsx)
- **Script npm (prod)** : `package.json` → `"mcp:prod": "node dist/mcp/mcp-server.mjs"` (consomme le build `tsc`)
- **`.mcp.json`** : `cmd /c npx tsx --env-file=.env src/mcp/mcp-server.mts` (wrapper `cmd /c` requis sous Windows)
- **Serveur MCP réel** : `src/mcp/mcp-server.mts` — JSON-RPC 2.0 sur stdio, registre des 5 tools (un fichier `*.tool.mts` par tool dans `src/mcp/`).
- **API programmatique** : `src/index.mts` — re-exporte la surface publique pour usage en bibliothèque.
- **Build** : `tsc` compile `src/**/*.mts` vers `dist/**/*.mjs` + `dist/**/*.d.mts` (sourcemaps inclus). `main` pointe vers `dist/index.mjs`.

## 3. Arbre annoté de `src/`

```
src/
├── index.mts                    API programmatique (re-exports publics)
│
├── mcp/                         ── Couche MCP (transport + dispatch + wrappers de tools)
│   ├── mcp-server.mts                          Serveur JSON-RPC stdio, registre + dispatcher (wrap chaque appel via withMcpDegradation)
│   ├── estimate-evolution.tool.mts             Tool MCP estimateEvolution (schéma + handler, délègue à work-on-evolution)
│   ├── evaluate-map.tool.mts                   Tool MCP evaluateMap (handler thin sur evaluateMapFile)
│   ├── identify-capability.tool.mts            Tool MCP identifyCapability (handler thin sur identifyCapability)
│   ├── estimate-anchor-evolution.tool.mts      Tool MCP estimateAnchorEvolution (handler thin sur estimateAnchorEvolution)
│   ├── generate-value-chain.tool.mts           Tool MCP generateValueChain (instancie TopDownChainStrategy)
│   ├── generate-value-chain.tool.test.mts      Tests du tool generateValueChain (mock LLM)
│   ├── boot-health-checks.mts                  Enregistrement des health-checks par défaut (bigquery, llm:*, web-search)
│   ├── mcp-server-dispatch.test.mts            Test de la fusion Degradable au dispatch
│   └── mcp-tool-transparent.test.mts           Tests AC 12 (estimateEvolution transparent solution/capability)
│
├── schemas/                     ── Schémas Zod (source de vérité unique)
│   ├── estimate-evolution.schema.mts      Entrée de estimateEvolution
│   ├── evaluate-map.schema.mts            Entrée de evaluateMap
│   ├── identify-capability.schema.mts     Entrée de identifyCapability
│   ├── estimate-anchor-evolution.schema.mts  Entrée de estimateAnchorEvolution
│   ├── generate-value-chain.schema.mts    Entrée de generateValueChain
│   ├── value-chain.schema.mts             Schémas internes du pipeline write:chain (Raw/PositionedValueChain, ChainMetadata)
│   ├── inputs.schema.mts                  Primitives + ComponentInput, SolutionInput, PhaseDistribution
│   ├── results.schema.mts                 EvolutionResult, PropertyEvaluation, SolutionEvolutionResult
│   ├── patent.schema.mts                  PatentDataSchema + 8 sous-shapes (BigQuery/mock)
│   ├── parsed-llm.schema.mts              Schémas des parsers LLM
│   └── …
│   Les 5 schémas d'entrée MCP génèrent le JSON Schema exposé au client via
│   `z.toJSONSchema(Schema, { io: 'input' })` et les types TS via `z.infer<…>`.
│
├── types/                       ── Re-exports typés (pour imports plus courts)
│   └── value-chain.mts                    Types du pipeline write:chain (RawValueChain, PositionedValueChain, …)
│

├── lib/                         ── Code réutilisable inter-domaines (cross work-on-*)
│   ├── component-detection.mts  Heuristiques de détection de composants
│   ├── known-dictionaries.mts   Dictionnaires de référence (termes connus)
│   ├── language-detect.mts      Détection FR/EN
│   ├── language-detect.test.mts
│   ├── mcp-notifications.mts    Émetteur de notifications <channel>
│   ├── mcp-notifications.test.mts
│   ├── owm/                     ── Catalogue OWM DSL + couche d'isolation moteur de rendu
│   │   ├── owm-dsl.mts                emit{Title,Anchor,Component,Link,Size,…} + OWM_DSL_REFERENCE
│   │   ├── render-adapter.mts         Interface OwmRenderAdapter (DSL → SVG) — utilisée par cli-owm-adapter et le boot health check
│   │   ├── cli-owm-adapter.mts        Impl concrète backed by src/lib/vendor/cli-owm ; honore size [w,h] du DSL via map.presentation.size ; sert d'oracle aux tests régression analytical-geometry
│   │   ├── svg-bbox-parser.mts        SVG → SvgGeometry { items, edges, canvas, mapArea, phaseAxes } (kept for snapshot tests / future Playwright fallback)
│   │   ├── analytical-geometry.mts    computeGeometry — pure-JS replacement, no cli-owm calls during placement (V6)
│   │   └── overlap-detector.mts       detectAllOverlaps : rect-rect + label↔canvas + label↔edge + label-spacing + label-axis ; rectGap, bboxAxisCrossingWidth, segmentRectIntersects, segmentInRectLength
│   ├── vendor/                  ── Code tiers vendoré (verbatim sauf adaptations ESM)
│   │   └── cli-owm/             cli-owm@4950f330 (GPL-2.0) — moteur de rendu OWM côté Node
│   │       ├── AUDIT.md, VENDORING.md, __smoke.test.mts
│   │       ├── index.mts, render.mts, themes.mts, version.mts
│   │       └── parser/          UnifiedConverter + 15 strategies + types/
│   ├── phase-distribution.mts   centroidEvolution / entropyConfidence / concentrationConfidence
│   ├── phase-distribution.test.mts
│   ├── progress-messages.mts    Messages de progression standards
│   ├── response-formatter.mts   Formatage sortie tool (FR/EN, markdown)
│   ├── degradation/             ── Framework générique de dégradation (voir docs/technical/degradation.md)
│   │   ├── types.mts                 Degradable<T> / DegradationEvent / HealthCheck
│   │   ├── registry.mts              registerHealthCheck / runHealthCheck / runAllHealthChecks
│   │   ├── collector.mts             DegradationCollector (record / recordError / merge / wrap)
│   │   ├── context.mts               AsyncLocalStorage : getCurrentCollector / withCollector
│   │   ├── with-degradation.mts      tryDegrade / tryDegradeAmbient
│   │   ├── mcp-wrapper.mts           withMcpDegradation (wrapper standard pour tout handler MCP)
│   │   ├── index.mts                 Re-exports publics
│   │   └── *.test.mts
│   ├── llm/
│   │   ├── llm-call.mts           Factories bas niveau : createLLMCall / createStructuredLLMCall / createOpenCode*Call
│   │   ├── copilot-sdk-call.mts   Factories GitHub Copilot SDK (text + structured via voie B JSON-parse)
│   │   ├── config.schema.mts      Zod schema du fichier llm.config.json
│   │   ├── config.loader.mts      Lecture + validation + cache du JSON
│   │   ├── strategy-ids.mts       Liste canonique des strategies + capability requise
│   │   ├── registry.mts           getStrategyLLM / getStrategyStructuredLLM / getStrategyLogprobLLM
│   │   ├── providers/
│   │   │   ├── provider.types.mts       Interface LLMProvider + UnsupportedCapabilityError
│   │   │   ├── agent-sdk-provider.mts   Wrapper Agent SDK Anthropic (text + structured)
│   │   │   ├── http-api-provider.mts    Wrapper OpenCode-style HTTP (text + logprobs)
│   │   │   └── copilot-sdk-provider.mts Wrapper GitHub Copilot SDK (text + structured)
│   │   ├── llm-error-handler.mts  Classification erreurs LLM (rate-limit, timeout, …)
│   │   └── llm-error-handler.test.mts
│   ├── prompts/                 ── Registre centralise des prompts LLM (voir prompts.config.json racine)
│   │   ├── interpolate.mts         Helper de substitution {{var}} (regex globale, toutes occurrences)
│   │   ├── parsers.mts             parseKeyValueBlock (separator=, any) + parseDelimitedBlock
│   │   ├── prompts.schema.mts      Zod schema du fichier prompts.config.json (templateFile: string | {system, user})
│   │   ├── config.loader.mts       Lecture JSON + MD, normalisation CRLF, validation variables, rejet {{...}} dans .system.md
│   │   ├── registry.mts            getPrompt(strategy, name) → { build, parse } — build() retourne { system?, user }
│   │   ├── builders-registry.mts   registerBuilder / getBuilder pour kind=function (retour string | {system, user})
│   │   ├── parsers-registry.mts    registerParser / getParser pour parser.kind=custom
│   │   ├── init.mts                Registration centrale des 14 parsers (side-effect import, importe depuis mcp-server.mts)
│   │   ├── registry-parse-equivalence.test.mts  Suite de non-regression byte-for-byte des 13 parsers
│   │   └── *.test.mts              Tests unitaires (interpolate, parsers, loader, registry)
│   ├── tool-config/             ── Loader de tool.config.json (routing auto/report par type)
│   │   ├── tool-config.schema.mts  Zod schema (estimateEvolution.auto/report par anchor/solution/capability)
│   │   ├── loader.mts              loadToolConfig + resolveStrategyForType (singleton lazy + cache + env override WARDLEY_TOOL_CONFIG)
│   │   └── loader.test.mts
│   └── patent/                  Primitives brevets génériques (BigQuery + indicateurs)
│       ├── bigquery-client.mts           Client BigQuery générique
│       ├── bigquery-patent-source.mts    Implem BigQuery de PatentDataSource
│       ├── bigquery-query-builders.mts   Requêtes SQL patents
│       ├── patent-data-source.mts        Interface abstraite PatentDataSource
│       ├── patent-indicators.mts         8 indicateurs pure functions
│       ├── mock-patent-source.mts        Mock pour tests
│       └── *.test.mts
│
├── session/                     ── Sessions conversationnelles (mode guided)
│   ├── conversation-session.mts         État + branching d'une conversation
│   ├── conversation-branching.test.mts
│   └── conversation-guided.test.mts
│
├── tests/                       ── Tests E2E cross-cutting (solution + output)
│   ├── output-unchanged.test.mts
│   ├── solution-conversational-e2e.test.mts
│   ├── solution-oneshot-e2e.test.mts
│   └── solution-result-assembly.test.mts
│
├── work-on-value-chain/         ── Tools centrés value chain / capabilities
│   ├── read/                    (slot vide pour stratégies "parametre fourni en input, raffinement")
│   │   ├── anchor/      { base-strategy.mts, registry.mts }
│   │   ├── component/   { base-strategy.mts, registry.mts }
│   │   └── chain/       { base-strategy.mts, registry.mts }
│   └── write/                   (stratégies "parametre inventé depuis rien")
│       ├── anchor/      { base-strategy.mts, registry.mts }
│       ├── component/                                  Domaine pur (le wrapper MCP vit dans src/mcp/identify-capability.tool.mts)
│       │   ├── lib/
│       │   │   ├── classification/
│       │   │   │   ├── wardley-type-classification.mts     Classification activity/practice/data/knowledge
│       │   │   │   └── infer-capability-from-solution.mts  Déduit la capability sous-jacente d'une solution nommée
│       │   │   ├── verification/
│       │   │   │   ├── dual-verification-orchestrator.mts  Pipeline 3 tiers naming/LLM/web-search
│       │   │   │   ├── concurrent-verification.mts         Variante parallèle (LLM + web-search concurrents)
│       │   │   │   ├── verification-reconciliation.mts     Réconciliation des signaux
│       │   │   │   ├── verification-signals.mts            Constructeurs de VerificationSignal
│       │   │   │   ├── signal-combiner.mts                 Fusion des signaux → verdict
│       │   │   │   └── web-search-verification.mts         Tier 3 via Agent SDK (web search)
│       │   │   └── capability/
│       │   │       └── identify-capability.mts             Décode un nom → capability (nature activity/practice/knowledge/data)
│       │   └── strategies/                                 base-strategy.mts + registry.mts (scan récursif 1 niveau)
│       └── chain/                                          Tool generateValueChain — pipeline 8 étapes top-down
│           ├── lib/
│           │   ├── layout/                                 Géométrie pure, déterministe (réutilisable par toute stratégie)
│           │   │   ├── compute-visibility.mts              Étape 3 — Y déterministe par-branche, multi-ancres, mapHeight
│           │   │   ├── adjust-x.mts                        Étape 4 — X déterministe autour de xHint, mapWidth
│           │   │   ├── place-labels.mts                    Étape 5 — placement labels initial (règles topologiques)
│           │   │   ├── verify-layout.mts                   Étape 6 — V6 force-directed + V7 canonical snap (analytical geometry)
│           │   │   ├── force-directed.mts                  simulateLabels + simulateComponents + projectHardConstraints
│           │   │   └── canonical-snap.mts                  V7 — snap V6 → canoniques V5 quand ne dégrade pas hard
│           │   ├── emit/
│           │   │   └── emit-owm.mts                        Étape 7 — émission OWM DSL via src/lib/owm/
│           │   └── llm/
│           │       └── extract-metadata.mts                Étape 1 — LLM angle/scope/objective/imperatives/temporality (générique)
│           └── strategies/
│               ├── base-strategy.mts, registry.mts         Registry à scan récursif (1 niveau)
│               └── top-down/                               write:chain:top-down (algorithme Wardley top-down)
│                   ├── top-down-strategy.mts               Orchestrateur (2 LLM seulement, xHint inline dans LLM #2)
│                   └── generate-chain.mts                  Étape 2 — LLM ancres + composants + liens A→B + xHint (prompt 'top-down')
│
└── work-on-evolution/           ── Cœur : pipeline d'évaluation d'évolution
    │
    ├── read/                    (slot vide pour "evolution fournie en input → correction/raffinement")
    │   ├── base-strategy.mts
    │   └── registry.mts
    │
    └── write/                   (toutes les stratégies actuelles : évolution inventée depuis un nom)
        │
        ├── estimate-evolution.mts                Orchestrateur principal ; exporte evaluateStrategiesInParallel pour la phase A
        ├── estimate-evolution.parallel.test.mts  Vérifie Promise.allSettled + isolation AsyncLocalStorage du collector
        ├── skill-handler.mts                     Handler Agent SDK dédié à estimateEvolution
        ├── skill-handler-parse.test.mts
        │
        ├── evaluate-map/
        │   ├── evaluate-map.mts                  Tool evaluateMap
        │   └── *.test.mts
        │
        ├── lib/                                  Helpers locaux au domaine evolution
        │   ├── evolution-input-validation.mts
        │   └── evolution-input-validation.test.mts
        │
        ├── routing/                              Classification + aiguillage mode/stratégie
        │   ├── classification-gate.mts           Gate économique (skip LLM si évident)
        │   ├── detect-solution.mts               Solution vs capacity (naming+LLM, les pipelines de vérification sont dans work-on-value-chain/write/component/)
        │   ├── mode-router.mts                   Conversational vs oneshot + branche anchor (court-circuit gate quand input.type === 'anchor')
        │   ├── strategy-resolver.mts             Traduit surface 'auto'/'report'/<specific> en plan de dispatch (lit tool.config.json)
        │   ├── solution-capability-router.mts
        │   ├── solution-dispatch.mts             Dispatcher des 12 propriétés (le `'all'` interne signifie "toutes les propriétés", distinct du surface)
        │   └── *.test.mts
        │
        ├── pipeline/                             Pipeline enriched (les modules d'identification ont migré vers work-on-value-chain/write/component/)
        │   ├── pipeline-enriched.mts             Mode enriched (pivot capability + bornes SotA/legacy)
        │   └── *.test.mts
        │
        ├── patent/                               Partie CPC-spécifique (brevets) — les primitives génériques sont dans src/lib/patent/
        │   ├── cpc-mapper.mts                    Mapping capability → CPC codes
        │   ├── cpc-taxonomy-cache.mts            Cache hiérarchie CPC
        │   └── *.test.mts
        │
        ├── s-curve/                              Transformation S-curve (partagée par plusieurs stratégies)
        │   ├── s-curve.mts                       computeEvolution, PUB_TYPE_CENTROIDS
        │   └── s-curve-transform.js              (.js : consommé par promptfoo)
        │
        └── strategies/                           Registres de stratégies pluggables (namespace method = "write:<family>:<name>")
            ├── anchor/
            │   └── estimate-anchor-evolution.mts Tool estimateAnchorEvolution
            │
            ├── capacity/                         6 stratégies "capacity"
            │   ├── base-strategy.mts, registry.mts
            │   ├── s-curve-strategy.mts              method = write:capacity:s-curve
            │   ├── llm-direct-strategy.mts            method = write:capacity:llm-direct
            │   ├── publication-analysis-strategy.mts  method = write:capacity:publication-analysis
            │   ├── timeline-benchmark-strategy.mts    method = write:capacity:timeline-benchmark
            │   ├── logprob-distribution-strategy.mts  method = write:capacity:logprob-distribution
            │   └── cpc-evolution-strategy.mts         method = write:capacity:cpc-evolution
            │
            └── solution/                         Stratégies "solution" (12 propriétés produit)
                ├── registry.mts, solution-base-strategy.mts
                ├── properties-strategy.mts           method = write:solution:properties
                ├── phase-classifier.mts, aggregate-properties.mts, assemble-result.mts
                ├── solution-evolution-result.mts
                └── evolution-properties.json         Données de référence
```

> Le namespace `<mode>:<family>:<strategy>` est documenté dans
> [strategy-namespace-convention.md](strategy-namespace-convention.md).

## 4. Graphe de dépendances (haut niveau)

```
                    src/mcp/mcp-server.mts
                         │
      ┌──────────────────┼───────────────────┬───────────────────────┐
      ▼                  ▼                   ▼                       ▼
  mcp-tool.mts   work-on-evolution/   work-on-value-chain/   work-on-evolution/
  (estimate       evaluate-map/        identify-capability    strategies/anchor/
   Evolution)    evaluate-map                                 estimate-anchor-evolution
      │
      ▼
  work-on-evolution/routing/mode-router
      │
      ├── classification-gate
      ├── eval-mode-dispatcher
      └── solution-capability-router
            │
            ▼
      work-on-evolution/pipeline/pipeline-enriched
            │
            ▼
      work-on-evolution/strategies/
            ├── capacity/registry ──▶ *-strategy.mts
            └── solution/registry  ──▶ properties-strategy / phase-classifier / …

Partagé par tous : src/lib/{llm/llm-call, mcp-notifications, response-formatter, language-detect}
```

## 5. Table de migration (ancien chemin → nouveau chemin)

Utiliser cette table pour réparer les imports. Les chemins sont **relatifs à `src/`** sauf indication.

**Round 4 (lib/strategies split + MCP centralisé + top-down rename — mai 2026)** :

| Ancien | Nouveau |
|---|---|
| `./mcp/mcp-tool.mts` | `./mcp/estimate-evolution.tool.mts` |
| `./work-on-value-chain/write/component/identify-capability.mts` (lib + tool) | lib: `./work-on-value-chain/write/component/lib/capability/identify-capability.mts`, tool: `./mcp/identify-capability.tool.mts` |
| `./work-on-value-chain/write/component/{infer-capability-from-solution,wardley-type-classification}.mts` | `./work-on-value-chain/write/component/lib/classification/<même fichier>.mts` |
| `./work-on-value-chain/write/component/{dual-verification-orchestrator,concurrent-verification,verification-reconciliation,verification-signals,signal-combiner,web-search-verification}.mts` | `./work-on-value-chain/write/component/lib/verification/<même fichier>.mts` |
| `./work-on-value-chain/write/component/{base-strategy,registry}.mts` | `./work-on-value-chain/write/component/strategies/<même fichier>.mts` |
| `./work-on-value-chain/write/chain/generate-value-chain.mts` (tool MCP) | `./mcp/generate-value-chain.tool.mts` |
| `./work-on-value-chain/write/chain/narrative-strategy.mts` | `./work-on-value-chain/write/chain/strategies/top-down/top-down-strategy.mts` (classe `TopDownChainStrategy`, méthode `write:chain:top-down`) |
| `./work-on-value-chain/write/chain/{compute-visibility,adjust-x,place-labels,force-directed,canonical-snap,verify-layout}.mts` | `./work-on-value-chain/write/chain/lib/layout/<même fichier>.mts` |
| `./work-on-value-chain/write/chain/emit-owm.mts` | `./work-on-value-chain/write/chain/lib/emit/emit-owm.mts` |
| `./work-on-value-chain/write/chain/extract-metadata.mts` | `./work-on-value-chain/write/chain/lib/llm/extract-metadata.mts` |
| `./work-on-value-chain/write/chain/generate-chain.mts` | `./work-on-value-chain/write/chain/strategies/top-down/generate-chain.mts` |
| `./work-on-value-chain/write/chain/{base-strategy,registry}.mts` | `./work-on-value-chain/write/chain/strategies/<même fichier>.mts` |
| `./work-on-evolution/write/evaluate-map/evaluate-map.mts` (lib + tool) | lib: inchangé. tool extrait : `./mcp/evaluate-map.tool.mts` |
| `./work-on-evolution/write/strategies/anchor/estimate-anchor-evolution.mts` (lib + tool) | lib: inchangé. tool extrait : `./mcp/estimate-anchor-evolution.tool.mts` |
| `prompts/write-chain.generate-chain.{system,user}.md` | `prompts/write-chain.top-down.{system,user}.md` (clé config: `write-chain` / `top-down`) |
| `prompts/logprob-distribution.{system,user}.md` | `prompts/logprob-fallback.{system,user}.md` (clé config: `logprob-fallback` / `default`) |
| `prompts/llm-direct.{with,without}-capability.{system,user}.md` | `prompts/historical-evolution.{with,without}-capability.{system,user}.md` (clé config: `historical-evolution`) |
| `method: 'write:chain:narrative'` | `method: 'write:chain:top-down'` |

**Round 3 (read/write split + component identification migration — avril 2026)** :

| Ancien | Nouveau |
|---|---|
| `./work-on-value-chain/identify-capability.mts` | `./work-on-value-chain/write/component/identify-capability.mts` |
| `./work-on-evolution/pipeline/dual-verification-orchestrator.mts` | `./work-on-value-chain/write/component/dual-verification-orchestrator.mts` |
| `./work-on-evolution/pipeline/concurrent-verification.mts` | `./work-on-value-chain/write/component/concurrent-verification.mts` |
| `./work-on-evolution/pipeline/verification-reconciliation.mts` | `./work-on-value-chain/write/component/verification-reconciliation.mts` |
| `./work-on-evolution/pipeline/verification-signals.mts` | `./work-on-value-chain/write/component/verification-signals.mts` |
| `./work-on-evolution/pipeline/signal-combiner.mts` | `./work-on-value-chain/write/component/signal-combiner.mts` |
| `./work-on-evolution/pipeline/pipeline-capability-inference.mts` | `./work-on-value-chain/write/component/infer-capability-from-solution.mts` (renommé) |
| `./work-on-evolution/routing/web-search-verification.mts` | `./work-on-value-chain/write/component/web-search-verification.mts` |
| `./work-on-evolution/routing/wardley-type-classification.mts` | `./work-on-value-chain/write/component/wardley-type-classification.mts` |
| `./work-on-evolution/<tout le reste>` | `./work-on-evolution/write/<tout le reste>` |
| `method: 's-curve'` / `publication-analysis` / … | `method: 'write:capacity:s-curve'` / `write:capacity:publication-analysis` / … |
| `method: 'solution-properties'` | `method: 'write:solution:properties'` |

**Round 2 (doctrine — avril 2026)** :

| Ancien | Nouveau |
|---|---|
| `./work-on-evolution/lib/estimate-evolution.mts` | `./work-on-evolution/estimate-evolution.mts` |
| `./mcp/skill-handler.mts` | `./work-on-evolution/skill-handler.mts` |
| `./work-on-evolution/patent/cpc-evolution-strategy.mts` (778 l) | `./work-on-evolution/strategies/capacity/cpc-evolution-strategy.mts` (remplace le proxy) |
| `./work-on-evolution/patent/{bigquery-*,patent-data-source,patent-indicators,mock-patent-source}.mts` | `./lib/patent/*.mts` |
| `src/work-on-evolution/write/s-curve/calibrate-s-curve.mts` | `scripts/calibrate-s-curve.mts` (hors `src/`) |

**Round 1 (réorg initiale)** :

| Ancien (importé dans le code) | Nouveau (emplacement réel) |
|---|---|
| `./tools/identify-capability.mts` | `./work-on-value-chain/identify-capability.mts` |
| `./evaluate-map/evaluate-map.mts` | `./work-on-evolution/evaluate-map/evaluate-map.mts` |
| `./evolution/estimate-anchor-evolution.mts` | `./work-on-evolution/strategies/anchor/estimate-anchor-evolution.mts` |
| `./estimate-anchor-evolution.mts` | `./work-on-evolution/strategies/anchor/estimate-anchor-evolution.mts` |
| `./estimate-evolution.mts` | `./work-on-evolution/lib/estimate-evolution.mts` |
| `./evolution-input-validation.mts` | `./work-on-evolution/lib/evolution-input-validation.mts` |
| `./classification-gate.mts` | `./work-on-evolution/routing/classification-gate.mts` |
| `./mode-router.mts` | `./work-on-evolution/routing/mode-router.mts` |
| `./detect-solution.mts` | `./work-on-evolution/routing/detect-solution.mts` |
| `./eval-mode-dispatcher.mts` | `./work-on-evolution/routing/eval-mode-dispatcher.mts` |
| `./solution-capability-router.mts` | `./work-on-evolution/routing/solution-capability-router.mts` |
| `./solution-dispatch.mts` | `./work-on-evolution/routing/solution-dispatch.mts` |
| `./wardley-type-classification.mts` | `./work-on-evolution/routing/wardley-type-classification.mts` |
| `./web-search-verification.mts` | `./work-on-evolution/routing/web-search-verification.mts` |
| `./pipeline-enriched.mts` | `./work-on-evolution/pipeline/pipeline-enriched.mts` |
| `./pipeline-capability-inference.mts` | `./work-on-evolution/pipeline/pipeline-capability-inference.mts` |
| `./concurrent-verification.mts` | `./work-on-evolution/pipeline/concurrent-verification.mts` |
| `./dual-verification-orchestrator.mts` | `./work-on-evolution/pipeline/dual-verification-orchestrator.mts` |
| `./verification-signals.mts` | `./work-on-evolution/pipeline/verification-signals.mts` |
| `./verification-reconciliation.mts` | `./work-on-evolution/pipeline/verification-reconciliation.mts` |
| `./signal-combiner.mts` | `./work-on-evolution/pipeline/signal-combiner.mts` |
| `./strategies/*` (registry, base-strategy, *-strategy capacity) | `./work-on-evolution/strategies/capacity/*` |
| `./strategies/solution/*` | `./work-on-evolution/strategies/solution/*` |
| `./calibrate-s-curve.mts` | `./work-on-evolution/s-curve/calibrate-s-curve.mts` |
| `./s-curve.mts` | `./work-on-evolution/s-curve/s-curve.mts` |
| `./s-curve-transform.js` | `./work-on-evolution/s-curve/s-curve-transform.js` |
| `./conversation-session.mts` | `./session/conversation-session.mts` |
| `./llm-call.mts` | `./lib/llm/llm-call.mts` |
| `./llm-error-handler.mts` | `./lib/llm/llm-error-handler.mts` |
| `./language-detect.mts` | `./lib/language-detect.mts` |
| `./response-formatter.mts` | `./lib/response-formatter.mts` |
| `./mcp-notifications.mts` | `./lib/mcp-notifications.mts` |
| `./progress-messages.mts` | `./lib/progress-messages.mts` |
| `./component-detection.mts` | `./lib/component-detection.mts` |
| `./known-dictionaries.mts` | `./lib/known-dictionaries.mts` |
| `./mcp-tool.mts` | `./mcp/mcp-tool.mts` |
| `./mcp-server.mts` | `./mcp/mcp-server.mts` |
| `./skill-handler.mts` | `./mcp/skill-handler.mts` |
| Patent (cpc/bigquery/patent-*) | `./work-on-evolution/patent/*` |

**Règle générale** : recalculer le préfixe `../` en fonction de la **profondeur du fichier source** par rapport à `src/`.

## 6. Fichiers racine de configuration

| Fichier | Rôle |
|---|---|
| `llm.config.json` | Config des providers + strategies LLM (voir `src/lib/llm/`) — **gitignore, par-utilisateur** |
| `llm.config.example.json` | Gabarit de depart (3 profils documentes dans `docs/technical/configuration.md`) |
| `prompts.config.json` | Registre des prompts par stratégie (kind template/function, parser custom/delimited/keyValue) |
| `prompts/*.system.md` / `prompts/*.user.md` | Prompts splités en paires (rôle/règles/format statiques dans `.system.md`, variables uniquement dans `.user.md`) — référencés par `templateFile: { system, user }` dans `prompts.config.json`. Règle dure : aucun `{{...}}` dans un fichier `.system.md` (vérifié par le loader). |
| `tool.config.json` | Routing par type pour `estimateEvolution`. Sections `auto` (1 stratégie par type) et `report` (n stratégies). Lu par `src/lib/tool-config/loader.mts` ; override via `WARDLEY_TOOL_CONFIG`. |
| `.env.example` | Documentation des variables d'environnement (OPENCODE_API_KEY, WARDLEY_LLM_CONFIG, WARDLEY_PROMPTS_CONFIG, WARDLEY_TOOL_CONFIG, …) |
| `.mcp.json` | Enregistrement du serveur MCP auprès de Claude Code |

## 7. Zones à ignorer

- `.claude/worktrees/**` — copies historiques d'anciennes branches de travail ; ne pas éditer.
- `node_modules/`, `.ouroboros/`, `maps/` (données d'exemple), `docs/` (sauf celui-ci).
