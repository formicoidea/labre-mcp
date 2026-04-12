# REPOTREEMAP — Cartographie du repo WardleyAssistant

> Source de vérité pour la navigation dans `src/` et pour la mise à jour des imports.
> Ce fichier est maintenu à la main : le mettre à jour à chaque réorganisation.

## 1. Vue d'ensemble

`WardleyAssistant` est un serveur **MCP** (Model Context Protocol) qui expose 5 outils autour des cartes Wardley :

| Outil MCP | Rôle | Entrée principale |
|---|---|---|
| `estimateEvolution` | Évalue l'évolution d'un composant (genesis → commodity) via 7 stratégies | `src/mcp/mcp-tool.mjs` |
| `generateValueChain` | Dérive une value chain d'une user need | `src/work-on-value-chain/generate-value-chain.mjs` |
| `evaluateMap` | Évalue qualitativement une carte OWM | `src/work-on-evolution/evaluate-map/evaluate-map.mjs` |
| `identifyCapability` | Identifie capabilities / solutions dans un texte | `src/work-on-value-chain/identify-capability.mjs` |
| `estimateAnchorEvolution` | Évolution du composant ancre (user need) | `src/work-on-evolution/strategies/anchor/estimate-anchor-evolution.mjs` |

## 2. Points d'entrée

- **Script npm** : `package.json` → `"mcp": "node src/mcp/mcp-server.mjs"`
- **Shim racine** : `src/mcp-server.mjs` — re-export pour compatibilité `.mcp.json` ancien.
- **Serveur MCP réel** : `src/mcp/mcp-server.mjs` — JSON-RPC 2.0 sur stdio, registre des 5 tools.
- **API programmatique** : `src/index.mjs` — re-exporte la surface publique pour usage en bibliothèque.

## 3. Arbre annoté de `src/`

```
src/
├── index.mjs                    API programmatique (re-exports publics)
├── mcp-server.mjs               Shim : relance src/mcp/mcp-server.mjs
│
├── mcp/                         ── Couche MCP (transport + dispatch)
│   ├── mcp-server.mjs           Serveur JSON-RPC stdio, registre + dispatcher
│   ├── mcp-tool.mjs             Tool "estimateEvolution" (schéma + handler)
│   └── mcp-tool-transparent.test.mjs
│
├── lib/                         ── Code réutilisable inter-domaines (cross work-on-*)
│   ├── component-detection.mjs  Heuristiques de détection de composants
│   ├── known-dictionaries.mjs   Dictionnaires de référence (termes connus)
│   ├── language-detect.mjs      Détection FR/EN
│   ├── language-detect.test.mjs
│   ├── mcp-notifications.mjs    Émetteur de notifications <channel>
│   ├── mcp-notifications.test.mjs
│   ├── progress-messages.mjs    Messages de progression standards
│   ├── response-formatter.mjs   Formatage sortie tool (FR/EN, markdown)
│   ├── llm/
│   │   ├── llm-call.mjs         createLLMCall / createStructuredLLMCall (OpenCode API)
│   │   ├── llm-error-handler.mjs  Classification erreurs LLM (rate-limit, timeout, …)
│   │   └── llm-error-handler.test.mjs
│   └── patent/                  Primitives brevets génériques (BigQuery + indicateurs)
│       ├── bigquery-client.mjs           Client BigQuery générique
│       ├── bigquery-patent-source.mjs    Implem BigQuery de PatentDataSource
│       ├── bigquery-query-builders.mjs   Requêtes SQL patents
│       ├── patent-data-source.mjs        Interface abstraite PatentDataSource
│       ├── patent-indicators.mjs         8 indicateurs pure functions
│       ├── mock-patent-source.mjs        Mock pour tests
│       └── *.test.mjs
│
├── session/                     ── Sessions conversationnelles (mode guided)
│   ├── conversation-session.mjs         État + branching d'une conversation
│   ├── conversation-branching.test.mjs
│   └── conversation-guided.test.mjs
│
├── tests/                       ── Tests E2E cross-cutting (solution + output)
│   ├── output-unchanged.test.mjs
│   ├── solution-conversational-e2e.test.mjs
│   ├── solution-oneshot-e2e.test.mjs
│   └── solution-result-assembly.test.mjs
│
├── work-on-value-chain/         ── Tools centrés value chain / capabilities
│   ├── generate-value-chain.mjs
│   ├── generate-value-chain-notifications.test.mjs
│   └── identify-capability.mjs
│
└── work-on-evolution/           ── Cœur : pipeline d'évaluation d'évolution
    │
    ├── estimate-evolution.mjs                    Orchestrateur principal (à la racine du domaine)
    ├── skill-handler.mjs                         Handler Agent SDK dédié à estimateEvolution
    │
    ├── evaluate-map/
    │   ├── evaluate-map.mjs                      Tool evaluateMap
    │   └── evaluate-map-notifications.test.mjs
    │
    ├── lib/                     Helpers locaux au domaine evolution
    │   ├── evolution-input-validation.mjs
    │   └── evolution-input-validation.test.mjs
    │
    ├── routing/                 Classification + aiguillage mode/stratégie
    │   ├── classification-gate.mjs               Gate économique (skip LLM si évident)
    │   ├── classification-gate.test.mjs
    │   ├── classification-gate-economic.test.mjs
    │   ├── detect-solution.mjs                   Solution vs capacity
    │   ├── detect-solution.test.mjs
    │   ├── eval-mode-dispatcher.mjs              Aiguillage fast/thorough
    │   ├── eval-mode-dispatcher.test.mjs
    │   ├── fallback-routing-trigger.test.mjs
    │   ├── mode-router.mjs                       conversational vs oneshot
    │   ├── mode-router.test.mjs
    │   ├── routing-wiring.test.mjs
    │   ├── solution-capability-router.mjs
    │   ├── solution-capability-router.test.mjs
    │   ├── solution-dispatch.mjs
    │   ├── wardley-type-classification.mjs
    │   ├── web-search-verification.mjs
    │   └── web-search-verification.test.mjs
    │
    ├── pipeline/                Pipeline enriched + vérification duale
    │   ├── concurrent-verification.mjs
    │   ├── dual-verification-concurrent.test.mjs
    │   ├── dual-verification-orchestrator.mjs
    │   ├── dual-verification-orchestrator.test.mjs
    │   ├── pipeline-capability-inference.mjs
    │   ├── pipeline-capability-input.test.mjs
    │   ├── pipeline-enriched.mjs                 Mode enriched (pivot capability + bornes SotA/legacy)
    │   ├── pipeline-entrypoint-wiring.test.mjs
    │   ├── pipeline-owm-syntax.test.mjs
    │   ├── pipeline-solution-discovery.test.mjs
    │   ├── signal-combiner.mjs
    │   ├── signal-combiner.test.mjs
    │   ├── verification-reconciliation.mjs
    │   ├── verification-signals.mjs
    │   └── verification-signals.test.mjs
    │
    ├── patent/                  Partie CPC-spécifique (brevets) — les primitives génériques sont dans src/lib/patent/
    │   ├── cpc-mapper.mjs                        Mapping capability → CPC codes
    │   ├── cpc-taxonomy-cache.mjs                Cache hiérarchie CPC
    │   └── *.test.mjs                            Tests de la stratégie CPC (confidence, cross-validation, …)
    │
    ├── s-curve/                 Transformation S-curve (partagée par plusieurs stratégies)
    │   ├── s-curve.mjs                           computeEvolution, PUB_TYPE_CENTROIDS
    │   └── s-curve-transform.js                  (.js : consommé par promptfoo)
    │
    └── strategies/              Registres de stratégies pluggables
        ├── anchor/
        │   ├── estimate-anchor-evolution.mjs     Tool estimateAnchorEvolution
        │   └── estimate-evolution-pilot.test.mjs
        │
        ├── capacity/            7 stratégies "capacity" (quel niveau d'évolution ?)
        │   ├── base-strategy.mjs                 Contrat de base
        │   ├── registry.mjs                      Auto-discovery (readdir + import())
        │   ├── llm-direct-strategy.mjs
        │   ├── logprob-distribution-strategy.mjs
        │   ├── publication-analysis-strategy.mjs
        │   ├── s-curve-strategy.mjs
        │   ├── timeline-benchmark-strategy.mjs
        │   ├── cpc-evolution-strategy.mjs        Stratégie CPC (778 l — logique complète ici, primitives dans lib/patent/)
        │   └── …  (+ tests pluggability/integration)
        │
        └── solution/            Stratégies "solution" (phase + propriétés produit)
            ├── registry.mjs
            ├── solution-base-strategy.mjs
            ├── properties-strategy.mjs
            ├── phase-classifier.mjs
            ├── aggregate-properties.mjs
            ├── assemble-result.mjs
            ├── solution-evolution-result.mjs
            ├── evolution-properties.json         Données de référence
            └── …  (+ tests)
```

## 4. Graphe de dépendances (haut niveau)

```
                      src/mcp-server.mjs (shim)
                                │
                                ▼
                    src/mcp/mcp-server.mjs
                         │
      ┌──────────────────┼────────────────────┬───────────────────┬───────────────────────┐
      ▼                  ▼                    ▼                   ▼                       ▼
  mcp-tool.mjs   work-on-value-chain/   work-on-evolution/   work-on-value-chain/   work-on-evolution/
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
            ├── capacity/registry ──▶ *-strategy.mjs
            └── solution/registry  ──▶ properties-strategy / phase-classifier / …

Partagé par tous : src/lib/{llm/llm-call, mcp-notifications, response-formatter, language-detect}
```

## 5. Table de migration (ancien chemin → nouveau chemin)

Utiliser cette table pour réparer les imports. Les chemins sont **relatifs à `src/`** sauf indication.

**Round 2 (doctrine — avril 2026)** :

| Ancien | Nouveau |
|---|---|
| `./work-on-evolution/lib/estimate-evolution.mjs` | `./work-on-evolution/estimate-evolution.mjs` |
| `./mcp/skill-handler.mjs` | `./work-on-evolution/skill-handler.mjs` |
| `./work-on-evolution/patent/cpc-evolution-strategy.mjs` (778 l) | `./work-on-evolution/strategies/capacity/cpc-evolution-strategy.mjs` (remplace le proxy) |
| `./work-on-evolution/patent/{bigquery-*,patent-data-source,patent-indicators,mock-patent-source}.mjs` | `./lib/patent/*.mjs` |
| `src/work-on-evolution/s-curve/calibrate-s-curve.mjs` | `scripts/calibrate-s-curve.mjs` (hors `src/`) |

**Round 1 (réorg initiale)** :

| Ancien (importé dans le code) | Nouveau (emplacement réel) |
|---|---|
| `./tools/generate-value-chain.mjs` | `./work-on-value-chain/generate-value-chain.mjs` |
| `./tools/identify-capability.mjs` | `./work-on-value-chain/identify-capability.mjs` |
| `./evaluate-map/evaluate-map.mjs` | `./work-on-evolution/evaluate-map/evaluate-map.mjs` |
| `./evolution/estimate-anchor-evolution.mjs` | `./work-on-evolution/strategies/anchor/estimate-anchor-evolution.mjs` |
| `./estimate-anchor-evolution.mjs` | `./work-on-evolution/strategies/anchor/estimate-anchor-evolution.mjs` |
| `./estimate-evolution.mjs` | `./work-on-evolution/lib/estimate-evolution.mjs` |
| `./evolution-input-validation.mjs` | `./work-on-evolution/lib/evolution-input-validation.mjs` |
| `./classification-gate.mjs` | `./work-on-evolution/routing/classification-gate.mjs` |
| `./mode-router.mjs` | `./work-on-evolution/routing/mode-router.mjs` |
| `./detect-solution.mjs` | `./work-on-evolution/routing/detect-solution.mjs` |
| `./eval-mode-dispatcher.mjs` | `./work-on-evolution/routing/eval-mode-dispatcher.mjs` |
| `./solution-capability-router.mjs` | `./work-on-evolution/routing/solution-capability-router.mjs` |
| `./solution-dispatch.mjs` | `./work-on-evolution/routing/solution-dispatch.mjs` |
| `./wardley-type-classification.mjs` | `./work-on-evolution/routing/wardley-type-classification.mjs` |
| `./web-search-verification.mjs` | `./work-on-evolution/routing/web-search-verification.mjs` |
| `./pipeline-enriched.mjs` | `./work-on-evolution/pipeline/pipeline-enriched.mjs` |
| `./pipeline-capability-inference.mjs` | `./work-on-evolution/pipeline/pipeline-capability-inference.mjs` |
| `./concurrent-verification.mjs` | `./work-on-evolution/pipeline/concurrent-verification.mjs` |
| `./dual-verification-orchestrator.mjs` | `./work-on-evolution/pipeline/dual-verification-orchestrator.mjs` |
| `./verification-signals.mjs` | `./work-on-evolution/pipeline/verification-signals.mjs` |
| `./verification-reconciliation.mjs` | `./work-on-evolution/pipeline/verification-reconciliation.mjs` |
| `./signal-combiner.mjs` | `./work-on-evolution/pipeline/signal-combiner.mjs` |
| `./strategies/*` (registry, base-strategy, *-strategy capacity) | `./work-on-evolution/strategies/capacity/*` |
| `./strategies/solution/*` | `./work-on-evolution/strategies/solution/*` |
| `./calibrate-s-curve.mjs` | `./work-on-evolution/s-curve/calibrate-s-curve.mjs` |
| `./s-curve.mjs` | `./work-on-evolution/s-curve/s-curve.mjs` |
| `./s-curve-transform.js` | `./work-on-evolution/s-curve/s-curve-transform.js` |
| `./conversation-session.mjs` | `./session/conversation-session.mjs` |
| `./llm-call.mjs` | `./lib/llm/llm-call.mjs` |
| `./llm-error-handler.mjs` | `./lib/llm/llm-error-handler.mjs` |
| `./language-detect.mjs` | `./lib/language-detect.mjs` |
| `./response-formatter.mjs` | `./lib/response-formatter.mjs` |
| `./mcp-notifications.mjs` | `./lib/mcp-notifications.mjs` |
| `./progress-messages.mjs` | `./lib/progress-messages.mjs` |
| `./component-detection.mjs` | `./lib/component-detection.mjs` |
| `./known-dictionaries.mjs` | `./lib/known-dictionaries.mjs` |
| `./mcp-tool.mjs` | `./mcp/mcp-tool.mjs` |
| `./mcp-server.mjs` | `./mcp/mcp-server.mjs` |
| `./skill-handler.mjs` | `./mcp/skill-handler.mjs` |
| Patent (cpc/bigquery/patent-*) | `./work-on-evolution/patent/*` |

**Règle générale** : recalculer le préfixe `../` en fonction de la **profondeur du fichier source** par rapport à `src/`.

## 6. Zones à ignorer

- `.claude/worktrees/**` — copies historiques d'anciennes branches de travail ; ne pas éditer.
- `node_modules/`, `.ouroboros/`, `maps/` (données d'exemple), `docs/` (sauf celui-ci).
