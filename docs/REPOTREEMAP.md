# REPOTREEMAP — Cartographie du repo WardleyAssistant

> Source de vérité pour la navigation dans `src/` et pour la mise à jour des imports.
> Ce fichier est maintenu à la main : le mettre à jour à chaque réorganisation.

## 1. Vue d'ensemble

`WardleyAssistant` est un serveur **MCP** (Model Context Protocol) qui expose 5 outils autour des cartes Wardley :

| Outil MCP | Rôle | Entrée principale |
|---|---|---|
| `estimateEvolution` | Évalue l'évolution d'un composant (genesis → commodity) via 7 stratégies | `src/mcp/mcp-tool.mts` |
| `generateValueChain` | Dérive une value chain d'une user need | `src/work-on-value-chain/generate-value-chain.mts` |
| `evaluateMap` | Évalue qualitativement une carte OWM | `src/work-on-evolution/evaluate-map/evaluate-map.mts` |
| `identifyCapability` | Identifie capabilities / solutions dans un texte | `src/work-on-value-chain/identify-capability.mts` |
| `estimateAnchorEvolution` | Évolution du composant ancre (user need) | `src/work-on-evolution/strategies/anchor/estimate-anchor-evolution.mts` |

## 2. Points d'entrée

- **Script npm (dev)** : `package.json` → `"dev": "tsx src/mcp/mcp-server.mts"` (charge les `.mts` via tsx)
- **Script npm (prod)** : `package.json` → `"mcp:prod": "node dist/mcp/mcp-server.mjs"` (consomme le build `tsc`)
- **`.mcp.json`** : `cmd /c npx tsx --env-file=.env src/mcp/mcp-server.mts` (wrapper `cmd /c` requis sous Windows)
- **Serveur MCP réel** : `src/mcp/mcp-server.mts` — JSON-RPC 2.0 sur stdio, registre des 5 tools.
- **API programmatique** : `src/index.mts` — re-exporte la surface publique pour usage en bibliothèque.
- **Build** : `tsc` compile `src/**/*.mts` vers `dist/**/*.mjs` + `dist/**/*.d.mts` (sourcemaps inclus). `main` pointe vers `dist/index.mjs`.

## 3. Arbre annoté de `src/`

```
src/
├── index.mts                    API programmatique (re-exports publics)
│
├── mcp/                         ── Couche MCP (transport + dispatch)
│   ├── mcp-server.mts           Serveur JSON-RPC stdio, registre + dispatcher
│   ├── mcp-tool.mts             Tool "estimateEvolution" (schéma + handler)
│   └── mcp-tool-transparent.test.mts
│
├── lib/                         ── Code réutilisable inter-domaines (cross work-on-*)
│   ├── component-detection.mts  Heuristiques de détection de composants
│   ├── known-dictionaries.mts   Dictionnaires de référence (termes connus)
│   ├── language-detect.mts      Détection FR/EN
│   ├── language-detect.test.mts
│   ├── mcp-notifications.mts    Émetteur de notifications <channel>
│   ├── mcp-notifications.test.mts
│   ├── progress-messages.mts    Messages de progression standards
│   ├── response-formatter.mts   Formatage sortie tool (FR/EN, markdown)
│   ├── llm/
│   │   ├── llm-call.mts         createLLMCall / createStructuredLLMCall (OpenCode API)
│   │   ├── llm-error-handler.mts  Classification erreurs LLM (rate-limit, timeout, …)
│   │   └── llm-error-handler.test.mts
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
│   ├── generate-value-chain.mts
│   ├── generate-value-chain-notifications.test.mts
│   └── identify-capability.mts
│
└── work-on-evolution/           ── Cœur : pipeline d'évaluation d'évolution
    │
    ├── estimate-evolution.mts                    Orchestrateur principal (à la racine du domaine)
    ├── skill-handler.mts                         Handler Agent SDK dédié à estimateEvolution
    │
    ├── evaluate-map/
    │   ├── evaluate-map.mts                      Tool evaluateMap
    │   └── evaluate-map-notifications.test.mts
    │
    ├── lib/                     Helpers locaux au domaine evolution
    │   ├── evolution-input-validation.mts
    │   └── evolution-input-validation.test.mts
    │
    ├── routing/                 Classification + aiguillage mode/stratégie
    │   ├── classification-gate.mts               Gate économique (skip LLM si évident)
    │   ├── classification-gate.test.mts
    │   ├── classification-gate-economic.test.mts
    │   ├── detect-solution.mts                   Solution vs capacity
    │   ├── detect-solution.test.mts
    │   ├── eval-mode-dispatcher.mts              Aiguillage fast/thorough
    │   ├── eval-mode-dispatcher.test.mts
    │   ├── fallback-routing-trigger.test.mts
    │   ├── mode-router.mts                       conversational vs oneshot
    │   ├── mode-router.test.mts
    │   ├── routing-wiring.test.mts
    │   ├── solution-capability-router.mts
    │   ├── solution-capability-router.test.mts
    │   ├── solution-dispatch.mts
    │   ├── wardley-type-classification.mts
    │   ├── web-search-verification.mts
    │   └── web-search-verification.test.mts
    │
    ├── pipeline/                Pipeline enriched + vérification duale
    │   ├── concurrent-verification.mts
    │   ├── dual-verification-concurrent.test.mts
    │   ├── dual-verification-orchestrator.mts
    │   ├── dual-verification-orchestrator.test.mts
    │   ├── pipeline-capability-inference.mts
    │   ├── pipeline-capability-input.test.mts
    │   ├── pipeline-enriched.mts                 Mode enriched (pivot capability + bornes SotA/legacy)
    │   ├── pipeline-entrypoint-wiring.test.mts
    │   ├── pipeline-owm-syntax.test.mts
    │   ├── pipeline-solution-discovery.test.mts
    │   ├── signal-combiner.mts
    │   ├── signal-combiner.test.mts
    │   ├── verification-reconciliation.mts
    │   ├── verification-signals.mts
    │   └── verification-signals.test.mts
    │
    ├── patent/                  Partie CPC-spécifique (brevets) — les primitives génériques sont dans src/lib/patent/
    │   ├── cpc-mapper.mts                        Mapping capability → CPC codes
    │   ├── cpc-taxonomy-cache.mts                Cache hiérarchie CPC
    │   └── *.test.mts                            Tests de la stratégie CPC (confidence, cross-validation, …)
    │
    ├── s-curve/                 Transformation S-curve (partagée par plusieurs stratégies)
    │   ├── s-curve.mts                           computeEvolution, PUB_TYPE_CENTROIDS
    │   └── s-curve-transform.js                  (.js : consommé par promptfoo)
    │
    └── strategies/              Registres de stratégies pluggables
        ├── anchor/
        │   ├── estimate-anchor-evolution.mts     Tool estimateAnchorEvolution
        │   └── estimate-evolution-pilot.test.mts
        │
        ├── capacity/            7 stratégies "capacity" (quel niveau d'évolution ?)
        │   ├── base-strategy.mts                 Contrat de base
        │   ├── registry.mts                      Auto-discovery (readdir + import())
        │   ├── llm-direct-strategy.mts
        │   ├── logprob-distribution-strategy.mts
        │   ├── publication-analysis-strategy.mts
        │   ├── s-curve-strategy.mts
        │   ├── timeline-benchmark-strategy.mts
        │   ├── cpc-evolution-strategy.mts        Stratégie CPC (778 l — logique complète ici, primitives dans lib/patent/)
        │   └── …  (+ tests pluggability/integration)
        │
        └── solution/            Stratégies "solution" (phase + propriétés produit)
            ├── registry.mts
            ├── solution-base-strategy.mts
            ├── properties-strategy.mts
            ├── phase-classifier.mts
            ├── aggregate-properties.mts
            ├── assemble-result.mts
            ├── solution-evolution-result.mts
            ├── evolution-properties.json         Données de référence
            └── …  (+ tests)
```

## 4. Graphe de dépendances (haut niveau)

```
                    src/mcp/mcp-server.mts
                         │
      ┌──────────────────┼────────────────────┬───────────────────┬───────────────────────┐
      ▼                  ▼                    ▼                   ▼                       ▼
  mcp-tool.mts   work-on-value-chain/   work-on-evolution/   work-on-value-chain/   work-on-evolution/
  (estimate       generate-value-chain   evaluate-map/        identify-capability    strategies/anchor/
   Evolution)                            evaluate-map                                 estimate-anchor-evolution
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

**Round 2 (doctrine — avril 2026)** :

| Ancien | Nouveau |
|---|---|
| `./work-on-evolution/lib/estimate-evolution.mts` | `./work-on-evolution/estimate-evolution.mts` |
| `./mcp/skill-handler.mts` | `./work-on-evolution/skill-handler.mts` |
| `./work-on-evolution/patent/cpc-evolution-strategy.mts` (778 l) | `./work-on-evolution/strategies/capacity/cpc-evolution-strategy.mts` (remplace le proxy) |
| `./work-on-evolution/patent/{bigquery-*,patent-data-source,patent-indicators,mock-patent-source}.mts` | `./lib/patent/*.mts` |
| `src/work-on-evolution/s-curve/calibrate-s-curve.mts` | `scripts/calibrate-s-curve.mts` (hors `src/`) |

**Round 1 (réorg initiale)** :

| Ancien (importé dans le code) | Nouveau (emplacement réel) |
|---|---|
| `./tools/generate-value-chain.mts` | `./work-on-value-chain/generate-value-chain.mts` |
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

## 6. Zones à ignorer

- `.claude/worktrees/**` — copies historiques d'anciennes branches de travail ; ne pas éditer.
- `node_modules/`, `.ouroboros/`, `maps/` (données d'exemple), `docs/` (sauf celui-ci).
