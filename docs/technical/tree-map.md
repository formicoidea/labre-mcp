# tree-map — Cartographie du repo labre-mcp

> Source de vérité pour la navigation dans `src/`. Maintenu à la main : le mettre à jour à chaque réorganisation (hard rule AGENT.md #36).
> Décrit le code **tel qu'il est**. Les chantiers de migration en cours (kernel `lib/`→`core/`, extraction `_legacy/`, câblage des outils) sont centralisés dans [roadmap.md](../architecture/roadmap.md).

## 1. Vue d'ensemble

`labre-mcp` est un serveur **MCP** (Model Context Protocol) exposé via un **daemon HTTP** (JSON-RPC 2.0). Il adresse ses capacités par une grammaire de methodId à 5 segments définie par le pivot [ast-schema.md](../architecture/ast-schema.md).

**Surface actuelle** (cf. [roadmap.md](../architecture/roadmap.md)) :

| Élément | État |
|---|---|
| Outils MCP câblés | `estimateEvolution` (métier) + `__ping__` (smoke). Les autres flux existent en recipes/stratégies, non exposés comme outils — roadmap B3. |
| Stratégies enregistrées | 85 au boot : **15 réelles** + **70 mocks** (`LABRE_DISABLE_MOCKS=1` isole les réelles). Liste des réelles : [ast-schema.md → « État d'implémentation »](../architecture/ast-schema.md). |

## 2. Points d'entrée

- **Daemon HTTP** : `src/core/transport/labre-daemon.mts` — écoute sur `127.0.0.1:6767` (override `LABRE_HTTP_PORT`). Endpoints : `POST /mcp` (JSON-RPC : `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/*`), `GET /health`, `GET /version`.
- **Boot** : `buildBootRegistry()` enregistre les outils MCP ; `buildStrategyRegistry()` (→ `strategy-registry-boot.mts`) peuple le `StrategyRegistry` via `register{Evolution,Chain,Common}Strategies` + `registerMocks` (sauf `LABRE_DISABLE_MOCKS=1`).
- **Scripts npm** : `dev`/`mcp` = `tsx src/core/transport/labre-daemon.mts` ; `mcp:prod` = `node dist/core/transport/labre-daemon.mjs` ; `build` = `tsc` ; `typecheck` = `tsc --noEmit` ; `test` = `tsx --test "src/**/*.test.mts"`.
- **`.mcp.json`** : enregistre le serveur comme `{ "type": "http", "url": "http://127.0.0.1:6767/mcp" }`. Le daemon doit tourner (`pnpm run dev`) pour que le client s'y connecte.
- **API programmatique** : `src/index.mts` re-exporte la surface publique.

## 3. Arbre annoté de `src/`

```
src/
├── index.mts                 API programmatique (re-exports publics)
│
├── core/                     ── KERNEL — invariant inter-frameworks
│   ├── registry/             StrategyRegistry (methodId → classe)            (ARCH-03)
│   ├── recipe/               recipe-runner, recipe.schema, recipe-loader,
│   │                         jsonpath-fanout (over: $.path)                  (ARCH-06/07/08)
│   ├── bus/                  event-bus RxJS + event.schema                   (ARCH-10)
│   ├── ast/                  base-strategy (contrat { signals,reasoning,insights,result }) (ARCH-22)
│   ├── context/              request-context (projectId, projectRoot, sessionId, domain) (ARCH-15)
│   ├── transport/            labre-daemon, http-server (Hono), mcp-handler (dispatch),
│   │                         json-rpc.schema, context-extractor, auth-middleware,
│   │                         strategy-registry-boot                          (ARCH-14)
│   ├── listeners/            artifact-writer-listener (core, toujours actif) (ARCH-12)
│   └── persistence/          artifact-writer, project-id-resolver            (ARCH-12/13)
│
├── lib/                      ── Utilitaires transverses (PAS encore sous core/ — roadmap B1)
│   ├── llm/                  registry, config.loader, llm-call, strategy-ids,
│   │                         providers/{agent-sdk, http-api, copilot-sdk}, llm-error-handler
│   ├── prompts/              registry, config.loader, builders/parsers-registry,
│   │                         interpolate, init (split .system.md / .user.md)
│   ├── owm/                  owm-dsl, render-adapter, cli-owm-adapter,
│   │                         analytical-geometry, overlap-detector, svg-bbox-parser
│   ├── degradation/          Degradable<T>, collector (AsyncLocalStorage),
│   │                         with-degradation, mcp-wrapper (withMcpDegradation)
│   ├── patent/               bigquery-* , patent-data-source, patent-indicators, mock-patent-source
│   ├── vendor/cli-owm/       cli-owm@4950f330 (GPL-2.0) vendoré + parser/
│   ├── zod/                  helpers Zod (validateOrThrow…)
│   ├── errors.mts
│   ├── language-detect.mts   détection FR/EN
│   ├── mcp-notifications.mts  émetteur de notifications <channel>
│   ├── phase-distribution.mts  centroidEvolution / entropyConfidence
│   ├── progress-messages.mts
│   └── response-formatter.mts  formatage sortie (FR/EN, markdown)
│
├── frameworks/               ── Domaines métier
│   ├── wardley/
│   │   ├── map/               sous-domaines mock (basemap, config, node, climate, zonage…)
│   │   ├── chain/            registry.mts (réel : top-down, owm parse/emit) ; read/, emit/ ;
│   │   │                     _legacy/write/{chain,component}/  ← stratégies réelles (roadmap B2)
│   │   ├── evolution/        registry.mts (réel : capacity + solution + anchor) ;
│   │   │                     _legacy/write/{strategies,routing,pipeline,patent,s-curve}/
│   │   ├── climate/  doctrine/  gameplay/  iteration/   mock-strategies (surface AST exposée)
│   ├── common/               registry.mts (réel : place-labels, overlap-check) ; layout/, toolbox/
│   ├── render/               wardley-map/{owm,image}/  (owm parse/emit réels, image mock)
│   ├── mocks-registry.mts    enregistre les 70 *.mock-strategy.mts
│
├── mcp/                      ── Wrapper du seul outil métier câblé
│   ├── estimate-evolution.tool.mts        ToolDefinition estimateEvolution
│   └── estimate-evolution-via-recipe.mts  dispatch via le recipe runner
│
├── schemas/                  ── Schémas Zod (source de vérité runtime)
│   └── estimate-evolution, evaluate-map, identify-capability, estimate-anchor-evolution,
│       generate-value-chain, value-chain, inputs, results, patent, parsed-llm
│
└── types/                    ── Re-exports typés (z.infer<…>)
    └── value-chain, solution, routing, pipeline, patent, llm, evolution, classification, index
```

> Les anciens dossiers `src/session/` et `src/tests/` (E2E) n'existent plus. Les tests vivent en `*.test.mts` à côté de leur module.

## 4. Graphe de dépendances (haut niveau)

```
client MCP ──HTTP──▶ core/transport/labre-daemon ──▶ http-server (Hono) ──▶ mcp-handler.dispatch
                                                                                  │ tools/call
                                                                                  ▼
                                                              mcp/estimate-evolution.tool
                                                                                  │
                                                                                  ▼
                                                       mcp/estimate-evolution-via-recipe
                                                                                  │
                                                                                  ▼
                                            core/recipe/recipe-runner ──▶ core/registry (StrategyRegistry)
                                                                                  │
                                       ┌──────────────────────────────────────────┤
                                       ▼                                          ▼
                          frameworks/wardley/evolution/registry        frameworks/wardley/chain/registry
                          frameworks/common/registry                   frameworks/mocks-registry

Partagé : lib/{llm, degradation, prompts, owm, response-formatter, language-detect, mcp-notifications}
```

## 5. Recipes livrées

`recipes/<domain>/<tool>/<name>.recipe.json` (shipped) + override possible sous `<projectRoot>/recipes/…` (ARCH-08). Schéma : `{ schemaVersion, name, domain, tool, steps[{ stepId, tool, in, out }], listeners[] }`.

- `recipes/wardley/map/estimate-component.recipe.json` — `node:identify:default` → `position-functional-in-evolution:llm-direct`
- `recipes/wardley/map/evaluate-map.recipe.json`
- `recipes/wardley/map/anchor-estimate.recipe.json`
- `recipes/wardley/map/generate.recipe.json`
- `recipes/render/wardley-map/parse.recipe.json` — `render:wardley-map:owm:parse:dsl`

## 6. Fichiers racine de configuration

| Fichier | Rôle |
|---|---|
| `llm.config.json` | Providers + mapping stratégie→provider/modèle — **gitignore, par-utilisateur** (`src/lib/llm/`) |
| `llm.config.example.json` | Gabarit (3 profils, voir [configuration.md](configuration.md)) |
| `prompts.config.json` | Registre des prompts par stratégie (paires `.system.md` / `.user.md`, parser custom/délimité/keyValue) |
| `prompts/*.{system,user}.md` | Prompts splités — aucun `{{…}}` dans un `.system.md` (vérifié par le loader) |
| `.env.example` | Variables d'environnement (`OPENCODE_API_KEY`, `WARDLEY_LLM_CONFIG`, `WARDLEY_PROMPTS_CONFIG`, `LABRE_HTTP_PORT`, `LABRE_DISABLE_MOCKS`…) |
| `.mcp.json` | Enregistrement du serveur HTTP auprès du client MCP |
| `promptfooconfig.yaml` | Configuration d'évaluation promptfoo (voir [evaluation.md](../functional/evaluation.md)) |

> Il n'y a **plus** de `tool.config.json` (purgé) : le routing par type passe désormais par les recipes et le strategy registry.

## 7. Zones à ignorer

- `.claude/worktrees/**` — copies historiques d'anciennes branches.
- `node_modules/`, `.ouroboros/`, `maps/` (données d'exemple), `dist/` (build).
