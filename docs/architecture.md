# Architecture

## Vue d'ensemble

WardleyAssistant est un serveur MCP implementant le protocole JSON-RPC 2.0 sur stdio. Il ne depend d'aucun framework externe pour le transport — le serveur lit stdin ligne par ligne et ecrit les reponses sur stdout.

## Pipeline de traitement

```
┌─────────────────────────────────────────────────────────┐
│                   mcp-server.mjs                        │
│  initialize | tools/list | tools/call | ping            │
└──────────────┬──────────────────────────────────────────┘
               │ tools/call dispatch
    ┌──────────┼──────────┐
    │          │          │
┌───▼───┐ ┌───▼───┐ ┌───▼────┐
│estimate│ │evaluate│ │generate│
│Evol.  │ │Map    │ │ValueCh.│
└───┬───┘ └───┬───┘ └───┬────┘
    │          │          │
    └──────────┼──────────┘
               │
    ┌──────────▼──────────┐
    │ Classification Gate │  social_good → re-question
    │ (fixe, non-pluggable)│  common_good → re-question
    └──────────┬──────────┘  economic → evaluation
               │
    ┌──────────▼──────────┐
    │    Mode Router      │
    │ oneshot | guided    │
    └──────────┬──────────┘
               │
    ┌──────────▼──────────┐
    │ Strategy Registry   │  auto-decouverte *-strategy.mjs
    │  6 strategies       │
    └──────────┬──────────┘
               │
    ┌──────────▼──────────┐
    │ Response Formatter  │  markdown, barres de confiance
    └──────────┬──────────┘
               │
    ┌──────────▼──────────┐
    │   Notifications     │  claude/channel + notifications/message
    └─────────────────────┘
```

## Modules par couche

### Transport MCP

| Module | Role |
|---|---|
| `mcp-server.mjs` | Serveur JSON-RPC 2.0 stdio, registre d'outils, dispatch |
| `mcp-tool.mjs` | Definition et handler de estimateEvolution |
| `evaluate-map.mjs` | Definition et handler de evaluateMap |
| `generate-value-chain.mjs` | Definition et handler de generateValueChain |

### Logique metier

| Module | Role |
|---|---|
| `classification-gate.mjs` | Gate fixe : mots-cles + signaux contextuels → espace economique |
| `mode-router.mjs` | Detection automatique du mode (oneshot/guided) + dispatch |
| `estimate-evolution.mjs` | Orchestration oneshot : classification → strategies → formatage |
| `conversation-session.mjs` | Machine a etats pour le mode guide (5 phases) |
| `skill-handler.mjs` | Parsing de langage naturel → appels API structures |
| `identify-capability.mjs` | Decode les noms techniques (CRM → gestion relation client) via LLM |

### Strategies

| Module | Role |
|---|---|
| `strategies/registry.mjs` | Auto-decouverte et cache des fichiers `*-strategy.mjs` |
| `strategies/base-strategy.mjs` | Interface abstraite (`evaluate()` + `validateResult()`) |
| `strategies/s-curve-strategy.mjs` | Modele dual sigmoide (certitude × ubiquite) |
| `strategies/publication-analysis-strategy.mjs` | Distribution wonder/build/operate/usage |
| `strategies/timeline-benchmark-strategy.mjs` | Timeline historique recursive |
| `strategies/llm-direct-strategy.mjs` | Estimation LLM directe (blend 70% s-curve + 30% LLM) |
| `strategies/logprob-distribution-strategy.mjs` | Logprobs OpenCode → distribution de probabilite |
| `strategies/sector-agent-strategy.mjs` | Agent sectoriel specialise |

### Mathematiques

| Module | Role |
|---|---|
| `s-curve.mjs` | Modele S-curve : sigmoide generalisee, bandes, zones, projection |
| `calibrate-s-curve.mjs` | Calibration des parametres du modele |
| `s-curve-visualizer.html` | Visualiseur interactif HTML5 Canvas |

### Infrastructure LLM

| Module | Role |
|---|---|
| `llm-call.mjs` | Interface multi-backend (Agent SDK + OpenCode) |
| `llm-error-handler.mjs` | Classification d'erreurs (timeout, rate_limit, auth, etc.) |

### Notifications et i18n

| Module | Role |
|---|---|
| `mcp-notifications.mjs` | Emission JSON-RPC (channel + standard), gating verbose |
| `progress-messages.mjs` | Catalogue de messages localises (10 langues, 40+ messages) |
| `language-detect.mjs` | Detection de langue par heuristiques et empreintes |

### Formatage

| Module | Role |
|---|---|
| `response-formatter.mjs` | Resultat → markdown (stade, confiance, raisonnement par strategie) |

## Dual backend LLM

Le systeme supporte deux backends LLM, selectionnes automatiquement :

```
                ┌─ _WARDLEY_NESTED=1 ──→ Claude Agent SDK (claude-sonnet-4-6)
llm-call.mjs ──┤
                └─ sinon ──────────────→ OpenCode API (kimi-k2.5)
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

```
Input: { name, context, certitude, ubiquity, ... }
  │
  ├─ validateInput()          Validation des parametres
  │
  ├─ detectMode()             Auto-detection oneshot/guided
  │
  ├─ classifyComponent()      Gate: social_good/common_good/economic
  │    └─ Si non-economic → buildReQuestions() → retour
  │
  ├─ loadStrategies()         Auto-decouverte des fichiers *-strategy.mjs
  │
  ├─ Phase A: strategies non-s-curve
  │    ├─ llm-direct.evaluate()
  │    ├─ logprob-distribution.evaluate()
  │    ├─ publication-analysis.evaluate()
  │    ├─ timeline-benchmark.evaluate()
  │    └─ sector-agent.evaluate()
  │
  ├─ Phase B: enrichissement
  │    └─ Moyenne des certitude/ubiquity des phases A
  │
  ├─ Phase C: s-curve avec donnees enrichies
  │    └─ s-curve.evaluate()
  │
  └─ formatResponse()         Markdown avec consensus, tableau, barres
```

## Flux de donnees — evaluateMap

```
Input: { filePath }
  │
  ├─ parseWardleyMap()        Regex: title, anchors, components, links
  │
  ├─ Pour chaque composant :
  │    ├─ classifyComponent()
  │    ├─ Si economic → estimateEvolutionOneShot()
  │    └─ Mise a jour des coordonnees [visibility, maturity]
  │
  ├─ Ecriture du fichier .wm mis a jour
  │
  └─ Rapport markdown (tableau original/nouveau/delta)
```

## Flux de donnees — generateValueChain

```
Input: { description, filename }
  │
  ├─ Appel LLM : decomposition en chaine de valeur JSON
  │    └─ { anchor, components: [{ name, visibility, dependencies }] }
  │
  ├─ Pour chaque composant + anchor :
  │    └─ estimateEvolutionOneShot() → maturity
  │
  ├─ generateWmContent()      Syntaxe OWM avec coordonnees
  │
  ├─ Ecriture du fichier .wm
  │
  └─ { wmContent, filePath, components, evaluations }
```
