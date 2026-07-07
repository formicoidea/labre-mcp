# tree-map — Cartographie du repo labre-mcp

> Source de vérité pour la navigation dans `src/`. Maintenu à la main : le mettre à jour à chaque réorganisation (hard rule AGENT.md #36).
> Décrit le code **tel qu'il est**. Les chantiers de migration en cours (kernel `lib/`→`core/`, extraction `_legacy/`, câblage des outils) sont centralisés dans [roadmap.md](../architecture/roadmap.md).

## 1. Vue d'ensemble

`labre-mcp` est un serveur **MCP** (Model Context Protocol) exposé via un **daemon HTTP** (JSON-RPC 2.0). Il adresse ses capacités par une grammaire de methodId à 5 segments définie par le pivot [ast-schema.md](../architecture/ast-schema.md).

**Surface actuelle** (cf. [roadmap.md](../architecture/roadmap.md)) :

| Élément | État |
|---|---|
| Outils MCP câblés | `estimateEvolution` (recette `estimate-component-evolution`), `runCommand` (invocation directe de n'importe quel methodId), `__ping__` (smoke). Recettes multi-étapes restantes (evaluateMap, generateValueChain) non encore exposées — roadmap B3. |
| Stratégies enregistrées | 85 au boot : **15 réelles** + **70 mocks** (`LABRE_DISABLE_MOCKS=1` isole les réelles). Liste des réelles : [ast-schema.md → « État d'implémentation »](../architecture/ast-schema.md). |

## 2. Points d'entrée

- **Daemon HTTP** : `src/core/transport/labre-daemon.mts` — écoute sur `127.0.0.1:6767` (override `LABRE_HTTP_PORT`). Endpoints : `POST /mcp` (JSON-RPC : `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/*`), `GET /health`, `GET /version`.
- **Entrée stdio** : `src/core/transport/labre-stdio.mts` — JSON-RPC newline-delimited sur stdin/stdout, transport que Claude Code / l'Agent SDK lancent directement (`{ "command": "npx", "args": ["-y", "labre-mcp"] }`). Réutilise le même `dispatch` + `buildBootRegistry()` que le daemon ; stdout est réservé au protocole (réponses + notifications), tout le reste va sur stderr.
- **Boot** : `buildBootRegistry()` (→ `boot-tool-registry.mts`, partagé HTTP + stdio) enregistre les outils MCP ; `buildStrategyRegistry()` (→ `strategy-registry-boot.mts`) peuple le `StrategyRegistry` via `register{Evolution,Chain,Common}Strategies` + `registerMocks` (sauf `LABRE_DISABLE_MOCKS=1`).
- **Scripts npm** : `dev`/`mcp` = `tsx --conditions labre-mcp-dev src/core/transport/labre-daemon.mts` ; `mcp:prod` = `node dist/core/transport/labre-daemon.mjs` ; `mcp:stdio` = `tsx --conditions labre-mcp-dev src/core/transport/labre-stdio.mts` ; `mcp:stdio:prod` = `node dist/core/transport/labre-stdio.mjs` ; `build` = `tsc` ; `typecheck` = `tsc --noEmit` ; `test` = `tsx --conditions labre-mcp-dev --test "src/**/*.test.mts"`.
- **Subpath imports conditionnels** : le mapping `#core/*`, `#lib/*`, … (package.json `imports`) est `{ "labre-mcp-dev": "./src/*", "default": "./dist/*" }`. Le dev passe `--conditions labre-mcp-dev` (résout vers `src/`, tsx remappe `.mjs`→`.mts`) ; node pur en prod prend `default` (résout vers `dist/`). Sans ça les `.mjs` compilés tentent de résoudre vers `src/*.mjs` inexistant.
- **Exports npm** : package.json `exports` expose `.` (entrée principale `dist/index.mjs`) et `./schemas` (barrel `src/schemas/index.mts` → `dist/schemas/index.mjs`, même motif conditionnel `development`/`default`). `@formicoidea/labre-mcp/schemas` sert le schéma de manifeste des strategy bundles au frontend d'admin.
- **`.mcp.json`** : deux modèles possibles — HTTP `{ "type": "http", "url": "http://127.0.0.1:6767/mcp" }` (le daemon doit tourner) ou stdio `{ "command": "npx", "args": ["-y", "labre-mcp"] }` (Claude Code lance le process lui-même, cible de la publication npm).
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
│   ├── transport/            labre-daemon (HTTP), labre-stdio (stdio), http-server (Hono,
│   │                         hook onAuthenticated post-auth/pré-dispatch), mcp-handler (dispatch),
│   │                         boot-tool-registry, json-rpc.schema, context-extractor,
│   │                         auth-middleware, jwks-auth (cœur OIDC générique),
│   │                         supabase-auth (preset), boot-health-checks,
│   │                         strategy-registry-boot                          (ARCH-14)
│   ├── listeners/            artifact-writer-listener (core, toujours actif) (ARCH-12),
│   │                         posthog-telemetry-listener (run-end/step-error → capture,
│   │                         attaché par runRecipe quand PostHog est configuré)
│   └── persistence/          artifact-writer, project-id-resolver            (ARCH-12/13)
│
├── lib/                      ── Utilitaires transverses (PAS encore sous core/ — roadmap B1)
│   ├── llm/                  registry, config.loader, llm-call, strategy-ids,
│   │                         providers/{agent-sdk, http-api, copilot-sdk}, llm-error-handler
│   ├── prompts/              registry, config.loader, builders/parsers-registry,
│   │                         interpolate, init (split .system.md / .user.md)
│   ├── owm/                  owm-dsl, render-adapter, cli-owm-adapter,
│   │                         analytical-geometry, overlap-detector, svg-bbox-parser
│   ├── bundles/              bundle-loader : validation des strategy bundles v0 (cœur
│   │                         loadBundleFromFiles en mémoire + wrapper loadBundleFromDir),
│   │                         registerBundle ; supabase-bundle-source : fetch distant lazy
│   │                         avec le JWT de l'appelant (RLS), sha256 + swap atomique
│   ├── degradation/          Degradable<T>, collector (AsyncLocalStorage),
│   │                         with-degradation, mcp-wrapper (withMcpDegradation)
│   ├── flags/                posthog (buildPostHog : gate fail-open + capture + shutdown,
│   │                         posthog-node en import dynamique), state (singleton posé au boot
│   │                         du daemon ; clé de flag mcp-recipe-<domain>-<tool>-<name>)
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
│   │   ├── map/               basemap/generate (réel), value-chain/{generate/top-down, organized-y-position, select-by-type/component} (réels, WardleyMap→…) ; config, node, climate, zonage… (mock)
│   │   ├── chain/            registry.mts (réel : basemap + value-chain generate/organized-y/select-by-type + owm parse/emit) ; read/, emit/ ;
│   │   │                     _legacy/write/{chain,component}/  ← stratégies réelles (roadmap B2)
│   │   ├── evolution/        registry.mts (réel : capacity + solution + anchor) ;
│   │   │                     _legacy/write/{strategies,routing,pipeline,patent,s-curve}/
│   │   ├── climate/  doctrine/  gameplay/  iteration/   mock-strategies (surface AST exposée)
│   ├── common/               registry.mts (réel : place-labels, overlap-check — I/O canonique WardleyMap) ; layout/, toolbox/
│   ├── render/               wardley-map/{owm,image}/  (owm parse/emit réels, image/emit/svg réel = renderToSVG)
│   │   └── wardley-map/acl/  anti-corruption layer : WardleyMap ↔ PositionedValueChain (inverse la convention de visibilité : legacy 0.95=haut ↔ renderer 0=haut)
│   ├── mocks-registry.mts    enregistre les 67 *.mock-strategy.mts
│
├── mcp/                      ── Wrappers des outils MCP câblés
│   ├── estimate-evolution.tool.mts        ToolDefinition estimateEvolution
│   ├── estimate-evolution-via-recipe.mts  dispatch via le recipe runner
│   ├── run-command.tool.mts               ToolDefinition runCommand (methodId direct)
│   ├── run-recipe.tool.mts                ToolDefinition runRecipe (recette par nom)
│   ├── shipped-root.mts                   résolution SHIPPED_ROOT (partagé)
│   └── resolve-context.mts                résolution RequestContext (partagé)
│
├── schemas/                  ── Schémas Zod (source de vérité runtime)
│   ├── index.mts             barrel exporté en npm via `exports["./schemas"]` (surface externe)
│   ├── strategy-bundle.schema.mts  manifeste des strategy bundles v0 (slug, permissions, prompts)
│   └── estimate-evolution, evaluate-map, identify-capability, estimate-anchor-evolution,
│       generate-value-chain, value-chain, command, run-recipe, inputs, results, patent, parsed-llm,
│       wardley-map (ré-export du schéma du package @formicoidea/wardley-map-renderer), json-labre (artefact root)
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

Partagé : lib/{llm, degradation, flags, prompts, owm, response-formatter, language-detect, mcp-notifications}
```

## 5. Recipes livrées

`recipes/<domain>/<tool>/<name>.recipe.json` (shipped) + override possible sous `<projectRoot>/recipes/…` (ARCH-08). Schéma : `{ schemaVersion, name, domain, tool, steps[{ stepId, tool, in, out }], listeners[] }`.

- `recipes/wardley/map/estimate-component-evolution.recipe.json` — `node:identify:default` → `position-functional-in-evolution:llm-direct`
- `recipes/wardley/map/evaluate-map.recipe.json`
- `recipes/wardley/map/generate.recipe.json`
- `recipes/wardley/map/draw-value-chain.recipe.json` — prompt → chaîne de valeur (X = lisibilité, **pas** d'évolution) → SVG
- `recipes/wardley/map/estimate-chain-components.recipe.json` — `select-by-type:component` (anchors exclus) → fan-out `llm-direct` per-composant → annotations d'évolution (pas de rendu)

> Toutes les recettes livrées ont **≥ 2 étapes** (orchestration). Une commande seule s'appelle directement via l'outil MCP `runCommand` (cf. [tools-reference](../functional/tools-reference.md)) — pas via une recette mono-étape.

### Strategy bundles (v0)

Un **strategy bundle** est un paquet déclaratif data-only (aucun code exécutable) : `manifest.json` (schéma `src/schemas/strategy-bundle.schema.mts`, `schemaVersion: "0.1"`) + `recipe.json` (une seule recette, `name` = `slug` du manifeste) + paires de prompts optionnelles `prompts/<strategyId>/<name>.{system,user}.md`. Validation : `src/lib/bundles/bundle-loader.mts` (`loadBundleFromFiles` = cœur en mémoire via un lecteur injecté, `loadBundleFromDir` = wrapper local ; `registerBundle` insère la recette dans le lookup de `core/recipe/recipe-loader` — ordre : override projet > bundles en mémoire > shipped, collision avec une recette shipped rejetée). Fixture de dogfooding : `bundles/examples/evaluate-map-example/`.

**Source distante Supabase** (`src/lib/bundles/supabase-bundle-source.mts`) : le daemon ne détient AUCUNE clé Supabase propre (jamais la service-role) — `refreshIfStale(bearerToken)` crée un client éphémère avec le JWT de l'appelant + la clé anon (`@supabase/supabase-js` chargé par `import()` dynamique, jamais côté stdio), RLS autorise. Throttle TTL (défaut 300 s, `LABRE_BUNDLES_TTL_S`) avec sonde légère `max(updated_at)+count` ; chaque fichier re-vérifié sha256 contre le sceau de la table `strategy_bundles` (mismatch/échec de download ⇒ bundle rejeté avec événement de dégradation `slug@version`, les autres passent) ; swap atomique `resetBundleRecipes()` + ré-enregistrement synchrone ; échec total ⇒ l'ancien jeu continue de servir (stale-over-broken), jamais d'erreur dans la requête. Les prompts de bundle sont validés mais **inertes en v0** (pas injectés dans le prompt registry). Câblage : hook `onAuthenticated` de `http-server` monté par `labre-daemon` quand `LABRE_AUTH=supabase` + `SUPABASE_ANON_KEY` ; health check boot `strategy-bundles` (présence de config, pas de sonde réseau). Le token brut n'est jamais stocké ni loggé.

## 6. Fichiers racine de configuration

| Fichier | Rôle |
|---|---|
| `llm.config.json` | Providers + mapping stratégie→provider/modèle — **gitignore, par-utilisateur** (`src/lib/llm/`) |
| `llm.config.example.json` | Gabarit (3 profils, voir [configuration.md](configuration.md)) |
| `prompts.config.json` | Registre des prompts par stratégie (paires `.system.md` / `.user.md`, parser custom/délimité/keyValue) |
| `prompts/*.{system,user}.md` | Prompts splités — aucun `{{…}}` dans un `.system.md` (vérifié par le loader) |
| `.env.example` | Variables d'environnement (`OPENCODE_API_KEY`, `WARDLEY_LLM_CONFIG`, `WARDLEY_PROMPTS_CONFIG`, `LABRE_HTTP_PORT`, `LABRE_DISABLE_MOCKS`, `LABRE_AUTH`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `LABRE_BUNDLES_TTL_S`…) |
| `.mcp.json` | Enregistrement du serveur HTTP auprès du client MCP |
| `promptfooconfig.yaml` | Configuration d'évaluation promptfoo (voir [evaluation.md](../functional/evaluation.md)) |

> Il n'y a **plus** de `tool.config.json` (purgé) : le routing par type passe désormais par les recipes et le strategy registry.

## 7. Zones à ignorer

- `.claude/worktrees/**` — copies historiques d'anciennes branches.
- `node_modules/`, `.ouroboros/`, `maps/` (données d'exemple), `dist/` (build).
