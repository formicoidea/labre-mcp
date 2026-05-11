# Architecture

## Vue d'ensemble

labre-mcp est un serveur MCP implementant le protocole JSON-RPC 2.0. Le transport canonique est HTTP via le daemon dans `src/core/transport/labre-daemon.mts` (entry `pnpm mcp`). Une variante legacy stdio reste disponible via `pnpm mcp:legacy:stdio`.

## Pipeline de traitement

```mermaid
flowchart TD
    MCP["src/mcp/mcp-server.mts\ninitialize | tools/list | tools/call | ping"]
    MCP --> EE["estimateEvolution"]
    MCP --> EM["evaluateMap"]
    MCP --> IC["identifyCapability"]
    MCP --> AN["estimateAnchorEvolution"]

    EE & EM & IC & AN --> Zod["Zod validation\nsrc/schemas/*.schema.mts"]
    Zod --> CG["Classification Gate\n(social_good / common_good / economic)"]
    CG -->|"non-economic"| RQ["Re-questions"]
    CG -->|"economic"| MR["Mode Router\noneshot | conversational"]

    MR --> SCR["Solution/Capability Router\nDetection 3-tiers :\nnaming → LLM → web search"]

    SCR -->|"solution detectee"| SS["Solution Strategies\n(12 proprietes Wardley)"]
    SCR -->|"capability detectee"| CS["Capability Strategies\n(7 strategies pluggables)"]

    SS & CS --> RF["Response Formatter\nmarkdown, barres de confiance"]
    RF --> N["Notifications\nclaude/channel + notifications/message"]
```

## Couche de degradation

Toutes les invocations MCP sont enveloppees au dispatch par `withMcpDegradation` (`src/lib/degradation/`). Cette couche etablit un `DegradationCollector` par invocation (via AsyncLocalStorage) et fusionne `degraded` + `degradationEvents` dans la reponse JSON-RPC.

```
client MCP -> mcp-server.mts
                  |
                  v
            withMcpDegradation
                  | (DegradationCollector + AsyncLocalStorage)
                  v
            handler(args) -> routing -> strategies -> loaders
                                          |
                                          | tryDegradeAmbient autour des appels externes
                                          | (BigQuery, LLM, web search, fichiers reseau)
                                          v
                                  collector.record / collector.recordError
                  |
                  v
            { ...result, degraded, degradationEvents }
```

Au boot, `src/mcp/boot-health-checks.mts` enregistre un health-check par dependance externe (`bigquery`, `llm:claude`, `llm:opencode`, `web-search`). Voir [degradation.md](degradation.md) pour les details.

## Parallélisation des appels indépendants

Partout où le MCP lance plusieurs appels indépendants dans la même invocation, on utilise **`Promise.allSettled`** — jamais un `for...of + await` séquentiel. Concrètement :

- **Capability `report` mode** (`src/work-on-evolution/write/estimate-evolution.mts`) : quand `strategy === 'report'`, le router resout la liste de strategies via `tool.config.json#report.capability` puis les lance en parallele via `evaluateStrategiesInParallel(entries, component)`. Le mode `auto` lance une seule strategie — pas de parallelisme requis.
- **Solution dispatch** (`src/work-on-evolution/write/routing/solution-dispatch.mts:149`) : les 12 proprietes solution tournent en parallele quand `strategy === 'all'` au niveau interne (semantique distincte du surface MCP — voir `docs/functional/strategies.md`).
- **`evaluateMap`** (`src/work-on-evolution/write/evaluate-map/evaluate-map.mts`) : les composants d'une map sont évalués en parallèle. Chaque composant reçoit son propre `DegradationCollector` injecté via `withCollector` et est mergé dans le collector parent après le settle, dans l'ordre d'input pour un output déterministe.

**Isolation des collectors** : la parallélisation est sûre parce que `src/lib/degradation/context.mts` utilise `AsyncLocalStorage`. Chaque branche async d'un `Promise.allSettled` hérite du contexte parent et voit son propre collector ambient — zéro fuite d'événements entre branches concurrentes. Cet invariant est vérifié empiriquement par `src/work-on-evolution/write/estimate-evolution.parallel.test.mts`.

**Choix délibérés** :
- Pas de borne de concurrence. Les maps larges peuvent saturer un provider LLM ; ces erreurs remontent dans `evaluations[i].reason` sans bloquer le batch. Ré-ouvrable en backlog si ça se manifeste.
- Pas de timeout per-stratégie. Une stratégie lente bloque uniquement son slot, pas le batch.

**Garde pour les nouvelles contributions** : dès qu'un call-site boucle sur un ensemble d'opérations indépendantes (stratégies, composants, signals), il doit utiliser `Promise.allSettled` — pas `for...of await`. Préserver la sémantique "une erreur n'en tue pas les autres" via un `try` interne ou le shape `{ status: 'fulfilled' | 'rejected' }`.

## TypeScript strict + Zod

Le projet est en **TypeScript strict** (`tsconfig.json` → `"strict": true`), extensions `.mts` (ESM strict). La chaine de build `tsc` compile `src/**/*.mts` vers `dist/**/*.mjs` + `dist/**/*.d.mts`.

**Zod est la source de verite unique** pour les schemas (voir [validation.md](validation.md) pour le detail) :
- `src/schemas/*.schema.mts` definissent les schemas Zod
- Le JSON Schema expose au client MCP est genere via `z.toJSONSchema(schema, { io: 'input' })`
- Les types TypeScript sont inferes via `z.infer<typeof Schema>`
- Les handlers appellent `Schema.parse(args)` pour valider a l'execution

Aucune duplication entre le JSON Schema MCP, les interfaces TS et la validation runtime.

## Modules par couche

### Transport MCP

| Module | Role |
|---|---|
| `src/mcp/mcp-server.mts` | Serveur JSON-RPC 2.0 stdio, registre de 4 outils, dispatch |
| `src/mcp/mcp-tool.mts` | Definition et handler de `estimateEvolution` |
| `src/work-on-evolution/write/evaluate-map/evaluate-map.mts` | Definition et handler de `evaluateMap` |
| `src/work-on-value-chain/write/component/identify-capability.mts` | Definition et handler de `identifyCapability` |
| `src/work-on-evolution/write/strategies/anchor/estimate-anchor-evolution.mts` | Definition et handler de `estimateAnchorEvolution` |

### Schemas (Zod)

| Module | Role |
|---|---|
| `src/schemas/estimate-evolution.schema.mts` | Schema Zod de `estimateEvolution` + type `EstimateEvolutionInput` |
| `src/schemas/evaluate-map.schema.mts` | Schema Zod de `evaluateMap` |
| `src/schemas/identify-capability.schema.mts` | Schema Zod de `identifyCapability` |
| `src/schemas/estimate-anchor-evolution.schema.mts` | Schema Zod de `estimateAnchorEvolution` |
| `src/schemas/patent.schema.mts` | `PatentDataSchema` + 8 sous-shapes (BigQuery / mock boundary) |
| `src/schemas/domain.schema.mts` | `ComponentInput`, `SolutionInput`, `EvolutionResult`, `PropertyEvaluation`, … |
| `src/schemas/parsed-llm.schema.mts` | Schemas de sortie des parsers LLM |

### Logique metier

| Module | Role |
|---|---|
| `src/work-on-evolution/write/routing/classification-gate.mts` | Gate fixe : mots-cles + signaux contextuels → espace economique |
| `src/work-on-evolution/write/routing/mode-router.mts` | Detection automatique du mode (oneshot/conversational/default) + branche anchor (court-circuit gate quand `input.type === 'anchor'`) + dispatch |
| `src/work-on-evolution/write/routing/strategy-resolver.mts` | Traduit surface `auto`/`report`/<specific> en plan de dispatch via `tool.config.json` |
| `src/work-on-evolution/write/estimate-evolution.mts` | Orchestration oneshot : classification → strategies → formatage |
| `src/session/conversation-session.mts` | Machine a etats pour le mode conversational (5 phases) |
| `src/work-on-evolution/write/skill-handler.mts` | Parsing de langage naturel → appels API structures |
| `src/work-on-value-chain/write/component/identify-capability.mts` | Decode les noms techniques (CRM → gestion relation client) via LLM |

### Routage Solution / Capability

| Module | Role |
|---|---|
| `src/work-on-evolution/write/routing/solution-capability-router.mts` | Detection du type de composant (solution vs capability) et dispatch |
| `src/work-on-evolution/write/routing/detect-solution.mts` | Heuristiques de nommage + fallback LLM (tiers 1 et 2) |
| `src/work-on-value-chain/write/component/dual-verification-orchestrator.mts` | Orchestration des 3 tiers de verification avec court-circuit |
| `src/work-on-value-chain/write/component/web-search-verification.mts` | Verification tier 3 via recherche web |
| `src/work-on-value-chain/write/component/signal-combiner.mts` | Fusion des signaux LLM + web search en verdict unique |
| `src/work-on-evolution/write/routing/eval-mode-dispatcher.mts` | Dispatch vers les registres de strategies selon le mode eval |

### Strategies Capability

| Module | Role |
|---|---|
| `src/work-on-evolution/write/strategies/capacity/registry.mts` | Auto-decouverte et cache des fichiers `*-strategy.mts` |
| `src/work-on-evolution/write/strategies/capacity/base-strategy.mts` | Interface abstraite (`evaluate()` + `validateResult()`) |
| `src/work-on-evolution/write/strategies/capacity/s-curve-strategy.mts` | Modele dual sigmoide (certitude × ubiquite) |
| `src/work-on-evolution/write/strategies/capacity/publication-analysis-strategy.mts` | Distribution wonder/build/operate/usage |
| `src/work-on-evolution/write/strategies/capacity/timeline-benchmark-strategy.mts` | Timeline historique recursive |
| `src/work-on-evolution/write/strategies/capacity/llm-direct-strategy.mts` | Estimation LLM directe (blend 70% s-curve + 30% LLM) |
| `src/work-on-evolution/write/strategies/capacity/logprob-distribution-strategy.mts` | Logprobs OpenCode → distribution de probabilite |
| `src/work-on-evolution/write/strategies/capacity/cpc-evolution-strategy.mts` | Brevets CPC via BigQuery (8 indicateurs certitude+ubiquite) |

### Strategies Solution

| Module | Role |
|---|---|
| `src/work-on-evolution/write/strategies/solution/registry.mts` | Auto-decouverte des fichiers `*-strategy.mts` dans `solution/` |
| `src/work-on-evolution/write/strategies/solution/solution-base-strategy.mts` | Classe abstraite solution (etend `BaseStrategy`) |
| `src/work-on-evolution/write/strategies/solution/properties-strategy.mts` | Evaluation des 12 proprietes Wardley (auto + conversationnel) |
| `src/work-on-evolution/write/strategies/solution/evolution-properties.json` | Reference : 12 proprietes × 4 phases avec descriptions |
| `src/work-on-evolution/write/strategies/solution/phase-classifier.mts` | Mapping propriete → phase (1-4) |
| `src/work-on-evolution/write/strategies/solution/aggregate-properties.mts` | Agregation ponderee des phases en evolution [0-1] |
| `src/work-on-evolution/write/strategies/solution/assemble-result.mts` | Enrichissement des resultats (stage, distribution, confiance) |
| `src/work-on-evolution/write/strategies/solution/solution-evolution-result.mts` | Modele de resultat solution avec validation |

### Mathematiques

| Module | Role |
|---|---|
| `src/work-on-evolution/write/s-curve/s-curve.mts` | Modele S-curve : sigmoide generalisee, bandes, zones, projection |
| `src/work-on-evolution/write/s-curve/s-curve-visualizer.html` | Visualiseur interactif HTML5 Canvas |

### Infrastructure LLM

| Module | Role |
|---|---|
| `src/lib/llm/llm-call.mts` | Interface multi-backend (Agent SDK + OpenCode) |
| `src/lib/llm/llm-error-handler.mts` | Classification d'erreurs (timeout, rate_limit, auth, etc.) |
| `src/lib/errors.mts` | Helpers `toErrorMessage`/`errorCode` pour narrowing sous `strict: true` |

### Notifications et i18n

| Module | Role |
|---|---|
| `src/lib/mcp-notifications.mts` | Emission JSON-RPC (channel + standard), gating verbose |
| `src/lib/progress-messages.mts` | Catalogue de messages localises (10 langues, 40+ messages) |
| `src/lib/language-detect.mts` | Detection de langue par heuristiques et empreintes |

### Formatage

| Module | Role |
|---|---|
| `src/lib/response-formatter.mts` | Resultat → markdown (stade, confiance, raisonnement par strategie) |

## Dual backend LLM

Le systeme supporte deux backends LLM, selectionnes automatiquement :

```mermaid
flowchart LR
    LLM["llm-call.mts"] -->|"_WARDLEY_NESTED=1"| SDK["Claude Agent SDK\n(claude-sonnet-4-6)"]
    LLM -->|"sinon"| OC["OpenCode API\n(kimi-k2.5)"]
```

| Backend | Modele par defaut | Quand | Logprobs |
|---|---|---|---|
| **Claude Agent SDK** | `claude-sonnet-4-6` | Sous-processus MCP (Agent SDK spawne un child) | Non |
| **OpenCode API** | `kimi-k2.5` | Session interactive Claude Code | Oui |

**Pourquoi deux backends ?** Le Claude Agent SDK cree un sous-processus qui entre en conflit avec une session Claude Code active. Quand le serveur tourne dans Claude Code, il utilise OpenCode pour eviter ce conflit. La variable `_WARDLEY_NESTED` est positionnee automatiquement par le serveur au demarrage.

**Configuration** : Le modele est configurable via `WARDLEY_LLM_MODEL` (env var).

## Guard anti-recursion

Le serveur MCP positionne `_WARDLEY_NESTED=1` au demarrage. Si un processus enfant herite de cette variable et tente de demarrer un second serveur MCP, il quitte proprement sans erreur. Cela empeche le spawn infini quand l'Agent SDK re-invoque le MCP.

## Flux de donnees — estimateEvolution

```mermaid
flowchart TD
    Input["Input: name, context, certitude, ubiquity, ..."]
    Input --> Validate["EstimateEvolutionInputSchema.parse()\n(Zod)"]
    Validate --> Mode["detectMode()\noneshot / conversational"]
    Mode --> Classify["classifyComponent()\nsocial_good / common_good / economic"]
    Classify -->|"non-economic"| ReQ["buildReQuestions() → retour"]
    Classify -->|"economic"| Detect["detectComponentType()\nDetection 3-tiers"]

    Detect --> Targets["determineRoutingTargets()\nWARDLEY_EVAL_MODE"]

    Targets -->|"solution"| SolPipe["Pipeline Solution"]
    Targets -->|"capability"| CapPipe["Pipeline Capability"]
    Targets -->|"parallel"| SolPipe & CapPipe

    subgraph SolPipe["Pipeline Solution"]
        direction TB
        SLoad["loadSolutionStrategies()"]
        SLoad --> SProp["properties-strategy.evaluate()\n12 proprietes → phases → evolution"]
        SProp --> SAssemble["assembleSolutionResult()\nstage, distribution, confiance"]
    end

    subgraph CapPipe["Pipeline Capability"]
        direction TB
        CLoad["loadStrategies()"]
        CLoad --> PhaseA["Phase A (parallèle) : llm-direct, logprob,\npub-analysis, timeline, sector-agent\nvia evaluateStrategiesInParallel → Promise.allSettled"]
        PhaseA --> PhaseB["Phase B : enrichissement\nmoyenne certitude/ubiquity"]
        PhaseB --> PhaseC["Phase C : s-curve enrichie"]
    end

    SolPipe & CapPipe --> Format["formatResponse()\nMarkdown, consensus, barres"]
```

### Detection solution vs capability — pipeline 3-tiers

Le routeur determine si un composant est une **solution nommee** (Kubernetes, Salesforce, SAP ERP) ou une **capability abstraite** (container orchestration, CRM, ERP). Le choix du pipeline d'evaluation en depend.

```mermaid
flowchart TD
    T1["Tier 1 : Nommage\nDictionnaires + regex\n< 1ms"]
    T1 -->|"conf >= 90%"| Stop1["Route directe"]
    T1 -->|"conf < 90%"| T2["Tier 2 : LLM\nClassification semantique\n~1-2s"]
    T2 -->|"conf >= 85%"| Stop2["Route directe"]
    T2 -->|"conf < 85%"| T3["Tier 3 : Web Search\nEvidence externe\n~2-5s"]
    T3 --> SC["Signal Combiner\nFusion LLM + web search"]
    SC --> Route["Route finale"]
```

Le **Signal Combiner** fusionne les signaux LLM et web search en un verdict unique :
- Accord → bonus de confiance (+0.10)
- Desaccord → poids LLM (0.45) vs web search (0.55), penalite de confiance (-0.10)
- Signal manquant → degradation (×0.85)

## Flux de donnees — evaluateMap

```mermaid
flowchart TD
    Input["Input: filePath"] --> Parse["parseWardleyMap()\ntitle, anchors, components, links"]
    Parse --> Loop["Pour chaque composant"]
    Loop --> Class["classifyComponent()"]
    Class -->|"economic"| Eval["estimateEvolutionOneShot()"]
    Eval --> Update["Mise a jour coordonnees\n[visibility, maturity]"]
    Update --> Write["Ecriture fichier .wm"]
    Write --> Report["Rapport markdown\ntableau original / nouveau / delta"]
```
