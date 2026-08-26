# Reference des outils MCP

labre-mcp tourne comme un **daemon HTTP** (`src/core/transport/labre-daemon.mts`) ecoutant sur `127.0.0.1:6767`. Les outils sont appeles via `POST /mcp` en JSON-RPC 2.0 (`tools/call`). Endpoints complementaires : `GET /health`, `GET /version`, et les methodes JSON-RPC `initialize`, `ping`, `tools/list`, `notifications/*`.

## Surface MCP reellement exposee

**6 outils** sont cables dans `buildBootRegistry()` :

| Outil | Role | Schema Zod |
|---|---|---|
| `estimateEvolution` | Estime l'evolution d'un composant (via la recipe `estimate-component-evolution`) | `src/schemas/estimate-evolution.schema.mts` |
| `generateValueChain` | Genere une chaine de valeur depuis une commande en langage naturel et l'emet en DSL OWM (via la recipe `generate`) | `src/schemas/generate-value-chain.schema.mts` |
| `evaluateMap` | Evalue tous les composants d'une carte OWM existante (via la recipe `evaluate-map`) | `src/schemas/evaluate-map.schema.mts` |
| `runCommand` | Invoque **n'importe quel methodId** directement → `CommandResult` (output + enveloppe JSON-labre) | `src/schemas/command.schema.mts` |
| `runRecipe` | Lance une **recette multi-etapes** par ref `<domain>:<tool>:<name>` (shipped, override projet ou bundle) → AST final + enveloppe + artefact | `src/schemas/run-recipe.schema.mts` |
| `__ping__` | Smoke tool — echo de l'input, valide le transport | (inline) |

`generateValueChain` puis `evaluateMap` forment le parcours nominal : **generer** la chaine de valeur (X = lisibilite), puis la **positionner** dans l'evolution. La sortie DSL du premier est directement l'entree du second.

Les schemas d'entree exposes au client MCP sont **generes a partir des schemas Zod** (`z.toJSONSchema(schema, { io: 'input' })`). Toute modification d'un schema passe par le fichier `src/schemas/*.schema.mts` correspondant.

> **Enveloppe de reponse `Degradable<T>`** : le dispatch enveloppe **chaque** reponse `tools/call` dans `{ result, degraded, degradationEvents }` (couche de degradation, hard rule #18). Dans tous les exemples ci-dessous, **le payload metier se lit sous `result.result`** (ex. `response.result.result.recipeRunId`). Omis dans les corps JSON pour la lisibilite.

> Les flux nommes `identifyCapability` et `estimateAnchorEvolution` n'ont pas d'**outil dedie** : ce sont des strategies uniques, **deja appelables directement** via `runCommand` avec le methodId correspondant — voir [Flux non exposes comme outils dedies](#flux-non-exposes-comme-outils-dedies).

---

## estimateEvolution

Estime la position d'evolution d'un composant sur l'axe de Wardley (0 = Genesis, 1 = Commodity). Supporte de maniere transparente les **solutions nommees** (Kubernetes, Salesforce) et les **capabilities abstraites** (CRM, container orchestration) — le routage est automatique.

### Schema d'entree

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `name` | string | **oui** | Nom du composant (ex: "ERP", "LLM", "Electricity", "Air") |
| `description` | string | non | Label / indice semantique du composant. Distinct de `context` (jamais un fallback). |
| `context` | string | non | Environnement metier dans lequel le composant existe (fourni par l'utilisateur). Distinct de `description`. |
| `certitude` | number [0-1] | non | Degre de comprehension (0=nouveau/incertain, 1=totalement compris). Requis par la strategie s-curve. |
| `ubiquity` | number [0-1] | non | Degre de diffusion (0=rare, 1=ubiquitaire). Requis par la strategie s-curve. |
| `phaseDistribution` | object | non | Distribution de probabilite sur l'axe d'evolution. Format : `{ bins: [{ position: 0..1, probability: 0..1 }] }` sommant a ~1. Consommee par la strategie publication-analysis (remplace les champs legacy wonder/build/operate/usage). |
| `space` | enum | non | Pre-classification : `economic`, `social_good`, `common_good`. Si fourni, by-passe la gate de classification. Si omis, detection automatique depuis name + context. |
| `strategy` | string | non | `"auto"` (defaut) route vers une strategie par type detecte (anchor / solution / capability). `"report"` fan-out multi-strategies par type. Un methodId specifique (ex: `"wardley:map:climate:position-functional-in-evolution:s-curve"`) by-passe le routing et execute cette strategie. |
| `mode` | enum | non | `oneshot`, `conversational`, `default`. `default` auto-detecte : oneshot si `space` ou parametres d'evaluation fournis, conversational sinon. |
| `forceEstimate` | boolean | non | Force l'estimation avec les donnees deja collectees (mode conversational). `false` par defaut. |
| `pipeline` | boolean | non | Active le mode pipeline enrichi : capability pivot + solution SotA + solution legacy, sortie OWM complete avec syntaxe pipeline. `false` par defaut. |

> La grammaire des methodId (`domain:tool:sous-domaine:command:strategie@version`) est definie dans [`../architecture/ast-schema.md`](../architecture/ast-schema.md). La liste des strategies reellement implementees figure dans [strategies.md](strategies.md).

### Modes d'execution

| Mode | Declenchement | Comportement |
|---|---|---|
| **oneshot** | `mode: "oneshot"` ou parametres suffisants (certitude+ubiquity ou phaseDistribution) | Evaluation immediate en un seul appel |
| **conversational** | `mode: "conversational"` ou parametres insuffisants | Conversation multi-tour avec questions progressives |
| **default** | Par defaut | Detecte le mode selon les parametres fournis |

### Detection automatique du mode

1. Parametre `mode` explicite (`oneshot` / `conversational`) → utilise ce mode
2. `space` pre-classifie → oneshot
3. Parametres d'evaluation suffisants → oneshot
4. Sinon → conversational

> `sessionState` a ete retire de l'entree de l'outil (CH-16) : ARCH-11 fixe V1 en
> requete/reponse synchrone, aucune session n'a jamais ete construite et le champ
> n'etait lu nulle part. L'entree est `.strict()` — le passer est desormais refuse.

### Exemple — oneshot (HTTP)

```bash
curl -X POST http://127.0.0.1:6767/mcp \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "estimateEvolution",
      "arguments": {
        "name": "ERP",
        "context": "Logiciel de gestion integre pour grandes entreprises",
        "mode": "oneshot",
        "space": "economic",
        "certitude": 0.9,
        "ubiquity": 0.85,
        "strategy": "auto"
      }
    }
  }'
```

### Exemple — mode conversational (tour 1)

```bash
curl -X POST http://127.0.0.1:6767/mcp \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "estimateEvolution",
      "arguments": {
        "name": "LLM",
        "context": "Modele de langage pour generation de texte"
      }
    }
  }'
```

Reponse : question de la phase suivante.

### Exemple — mode conversational (tour 2)

```bash
curl -X POST http://127.0.0.1:6767/mcp \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "estimateEvolution",
      "arguments": {
        "name": "LLM",
        "certitude": 0.6,
        "ubiquity": 0.5
      }
    }
  }'
```

### Exemple — solution nommee

```bash
curl -X POST http://127.0.0.1:6767/mcp \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "estimateEvolution",
      "arguments": {
        "name": "Kubernetes",
        "context": "Orchestration de conteneurs pour microservices",
        "mode": "oneshot",
        "space": "economic"
      }
    }
  }'
```

Le routeur detecte automatiquement "Kubernetes" comme une solution et route vers le pipeline des 12 proprietes Wardley.

### Structure de la reponse — capability

```json
{
  "mode": "oneshot",
  "modeReason": "explicit mode parameter: \"oneshot\"",
  "classification": {
    "space": "economic",
    "reason": "...",
    "requiresReQuestion": false
  },
  "routing": {
    "type": "capability",
    "confidence": 0.95,
    "method": "naming_heuristics",
    "evalMode": "exclusive"
  },
  "evaluations": {
    "wardley:map:climate:position-functional-in-evolution:s-curve": { "evolution": 0.76, "confidence": 0.85, "method": "wardley:map:climate:position-functional-in-evolution:s-curve" },
    "wardley:map:climate:position-functional-in-evolution:llm-direct": { "evolution": 0.72, "confidence": 0.90, "method": "wardley:map:climate:position-functional-in-evolution:llm-direct" }
  },
  "message": "Component \"ERP\" classified as economic. Evaluated with 6 strategy(ies).",
  "formatted": "## Evolution Estimation: ERP\n...",
  "nextQuestion": null,
  "phase": null
}
```

### Structure de la reponse — solution

```json
{
  "mode": "oneshot",
  "routing": {
    "type": "solution",
    "confidence": 0.98,
    "method": "known_solutions_dictionary",
    "evalMode": "exclusive"
  },
  "evaluations": {
    "wardley:map:climate:position-solution-in-evolution:property-assessment": {
      "evolution": 0.55,
      "confidence": 0.88,
      "method": "wardley:map:climate:position-solution-in-evolution:property-assessment",
      "stage": "Product",
      "meanPhase": 2.8,
      "phaseDistribution": { "1": 0, "2": 4, "3": 6, "4": 2 },
      "dominantPhase": { "phase": 3, "count": 6, "label": "Product" },
      "properties": [
        { "id": "market", "name": "Market", "phase": 3, "label": "Product", "confidence": 0.90 }
      ]
    }
  },
  "formatted": "## Evolution Estimation: Kubernetes\n..."
}
```

---

## generateValueChain

Genere une **chaine de valeur complete** (anchors, composants, liens, layout) depuis une commande en langage naturel, puis l'emet en DSL OWM. Enveloppe la recette 4 etapes `recipes/wardley/map/generate.recipe.json` :

`wardley:map:value-chain:generate:top-down` → `value-chain:prevent-collision:default` → `value-chain:audit:overlap-check` → `render:wardley-map:owm:emit:dsl`

> **X = lisibilite, jamais maturite.** A cette etape la coordonnee X est un layout de lisibilite ; l'axe d'evolution n'est revele qu'ensuite, par `evaluateMap` (ou les commandes climate `position-*-in-evolution`). Le rendu porte d'ailleurs `display.axisEvolution: false`.

### Schema d'entree

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `prompt` | string | **oui** | Commande en langage naturel decrivant la carte a generer (ex. `"Map the value chain of an online tea shop"`) |
| `context` | string | non | Environnement metier dans lequel la chaine de valeur existe. Distinct d'une `description` de composant : jamais un fallback pour elle. |

Le premier step de la recette consomme un **`WardleyMap` canonique** (basemap) et y relit la commande dans `title` / `context`. L'outil expose la paire en langage naturel et projette lui-meme l'entree sur ce squelette via la strategie deterministe `wardley:map:basemap:generate:default` (aucun LLM) avant de semer `$.input`.

### Exemple

```bash
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"generateValueChain", "arguments":{
    "prompt":"Map the value chain of an online tea shop",
    "context":"UK retail, 2026"
  }}
}'
```

### Structure de la reponse

```json
{
  "recipeRunId": "…",
  "dsl": "title Map the value chain of an online tea shop\nanchor Customer [0.95, 0.60]\ncomponent Cup of Tea [0.80, 0.55]\nCustomer->Cup of Tea\n",
  "ast": {
    "input":    { "title": "…", "context": "…", "components": [], "relations": [] },
    "chain":    { "result": { "…": "WardleyMap canonique genere par top-down" } },
    "laid":     { "result": { "…": "labels anti-collision" } },
    "verified": { "result": { "…": "audit overlap-check" } },
    "output":   { "result": { "dsl": "…", "emitted": true } }
  },
  "envelope": { "signals": [], "reasoning": [], "insights": [], "trace": [] },
  "events": [],
  "artifactPath": "~/.labre-mcp/runs/…json"
}
```

`dsl` est le raccourci vers `ast.output.result.dsl` ; il vaut `null` si l'etape d'emission n'a rien produit (l'AST complet reste disponible). Comme tous les outils, la reponse est enveloppee dans `Degradable<T>` — le payload se lit sous `result.result`.

---

## evaluateMap

Evalue **tous les composants** d'une carte OWM existante : position dans l'evolution et capability sous-jacente. Enveloppe la recette `recipes/wardley/map/evaluate-map.recipe.json` (1 parse + 2 fan-out paralleles) :

1. `render:wardley-map:owm:parse:dsl` — DSL → `WardleyMap` canonique, en `$.chain` (deterministe) ;
2. `wardley:map:climate:position-functional-in-evolution:llm-direct` — fan-out **par composant** sur `$.chain.result.map.components`, en `$.evaluations` (passe primaire) ;
3. `wardley:map:node:identify:default` — meme fan-out, en `$.identified` (observation, enveloppe uniquement).

### Schema d'entree

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `dsl` | string | **oui** | Source DSL OWM de la carte a evaluer. C'est le **contenu**, pas un chemin de fichier : le daemon ne lit jamais le systeme de fichiers de l'appelant. Les en-tetes `// cle: valeur` sont conserves et projetes sur le contexte d'etude. |

### Exemple

```bash
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"evaluateMap", "arguments":{
    "dsl":"title Tea Shop\nanchor Business [0.90, 0.60]\ncomponent Cup of Tea [0.80, 0.60]\n"
  }}
}'
```

### Structure de la reponse

```json
{
  "recipeRunId": "…",
  "ast": {
    "input":       { "dsl": "…" },
    "chain":       { "result": { "map": { "…": "WardleyMap canonique" }, "parsed": true, "warnings": [] } },
    "evaluations": [ { "result": { "evolution": 0.72, "confidence": 0.9, "method": "…:llm-direct" } } ],
    "identified":  [ { "result": { "…": "capability + nature" } } ]
  },
  "envelope": { "signals": [], "reasoning": [], "insights": [], "trace": [] },
  "events": [],
  "artifactPath": "~/.labre-mcp/runs/…json"
}
```

`evaluations` et `identified` sont des **tableaux alignes sur l'ordre des composants parses** (le fan-out utilise `Promise.allSettled` : un composant en echec laisse une entree `{ "error": "…" }` a son index, les autres aboutissent). La carte d'origine n'est pas reecrite : l'outil renvoie l'AST annote, a charge de l'appelant de re-emettre le DSL (`runCommand { command: "render:wardley-map:owm:emit:dsl" }`). Reponse enveloppee dans `Degradable<T>`.

---

## __ping__

Outil de smoke test : renvoie l'input echoe, sert a valider que le transport HTTP/JSON-RPC fonctionne.

```bash
curl -X POST http://127.0.0.1:6767/mcp \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "__ping__", "arguments": { "message": "hello" } }
  }'
```

Reponse : `{ "echoed": { "message": "hello" }, "daemon": "labre-mcp" }`.

---

## runCommand

Invoque une **commande unique** par son methodId 5 segments (ast-schema § 3.4.1). Le resultat est un `CommandResult` portant la sortie canonique de la strategie **et** l'enveloppe JSON-labre (`signals`, `reasoning`, `insights`, `trace`) — exactement comme un step de recipe. C'est le remplacant des recettes mono-etape.

### Entree (`CommandCall`)

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `command` | string | **oui** | methodId 5 segments `domain:tool:sous-domaine:command:strategie[@x.y.z]` (catalogue : [ast-schema.md](../architecture/ast-schema.md)) |
| `input` | any | non | Entree passee verbatim a la strategie (forme specifique a la commande) |
| `metadata` | object | non | `{ requestId?, requestedAt?, callerAgent? }` |

### Sortie (`CommandResult`)

`{ command, status: "ok"|"partial"|"error", output, envelope, warnings?, errors?, metadata }`. La reponse est en plus enveloppee dans `Degradable<T>` (`{ result, degraded, degradationEvents }`, cf. [degradation](../technical/degradation.md)). Un methodId inconnu renvoie `status: "error"`.

### Exemple

```bash
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"runCommand", "arguments":{
    "command":"render:wardley-map:owm:parse:dsl",
    "input":{ "dsl":"title Demo\ncomponent Foo [0.5, 0.5]" }
  }}
}'
```

> `runCommand` expose toute la surface du catalogue, **mocks compris** (61 stratégies renvoient un insight `mock strategy for <id>`). Les 25 stratégies réelles sont listées dans [ast-schema.md → État d'implémentation](../architecture/ast-schema.md).

### Commandes de parsing vers le JSON canonique

Les commandes du domaine `render` convergent des entrées divergentes (DSL OWM, SVG, PNG, texte) vers le `WardleyMap` canonique, et l'inverse. Toutes s'invoquent via `runCommand` ; sortie type `{ map, parsed, warnings }` (parse) ou `{ dsl | svg | pngBase64, ... }` (emit).

| Commande | Entrée | Nature | Notes |
| --- | --- | --- | --- |
| `render:wardley-map:owm:parse:dsl` | `{ dsl }` | déterministe | Round-trip byte-exact avec `owm:emit:dsl` sur le dialecte émis ; capture les en-têtes `// context:` etc. |
| `render:wardley-map:owm:emit:dsl` | `WardleyMap` | déterministe | Toute perte est déclarée en insight |
| `render:wardley-map:image:parse:svg` | `{ svg }` | déterministe | SVG émis par notre renderer ; inversion géométrique exacte |
| `render:wardley-map:image:emit:svg` | `WardleyMap` | déterministe | `renderToSVG` du renderer |
| `render:wardley-map:image:parse:png` | `{ pngBase64 }` | **LLM vision** | Nécessite un mapping `render-image-parse-png` vers un modèle vision dans `llm.config.json` ; couleurs arbitrées par les pixels ; positions = estimations visuelles |
| `render:wardley-map:image:emit:png` | `WardleyMap` | déterministe | `{ pngBase64 }`, ~1 s/rendu |
| `render:wardley-map:text:lint:default` | `{ text, target? }` | **LLM** | Lint d'une chaîne de valeur quasi structurée vers `json` (défaut) ou `owm` ; refuse (`NOT_A_VALUE_CHAIN`) un texte hors sujet |

Les JSON Schemas du contrat (map canonique, JSON-labre, CommandCall/CommandResult) sont servis par le daemon : `GET /schemas/wardley-map.schema.json`, `json-labre.schema.json`, `command-call.schema.json`, `command-result.schema.json`.

---

## runRecipe

Lance une **recette multi-etapes** par sa ref 3 segments `<domain>:<tool>:<name>`. Le loader resout dans l'ordre : override projet (`<projectRoot>/recipes/…`) > recette de **bundle** enregistree en memoire > shipped (cf. [recipes.md](../architecture/recipes.md)). Le resultat porte le `recipeRunId`, l'**AST final**, l'enveloppe JSON-labre (`signals`/`reasoning`/`insights`/`trace`) et le chemin de l'artefact persiste sous `~/.labre-mcp/runs/`.

### Entree (`RunRecipeCall`)

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `recipe` | string | **oui** | Ref 3 segments, ex. `wardley:map:draw-value-chain` |
| `input` | any | non | Seed de la recette, place en `$.input` de l'AST |

### Sortie

`{ recipe, status: "ok"|"error", recipeRunId?, ast?, envelope?, artifactPath?, errors? }` — enveloppe `Degradable<T>` comme les autres outils. Une ref inconnue renvoie `status: "error"`.

### Daemon + PostHog (optionnel)

Quand le daemon est configure avec `POSTHOG_API_KEY`, `runRecipe` est le seul outil gate par flag de rollout (`mcp-recipe-<domain>-<tool>-<name>`, fail-open) et instrumente : telemetrie `mcp_run_end`/`mcp_step_error` (latence, `llmCalls`, tokens, `quality_*`) et **experiences de prompts A/B** (`mcp-prompt-<strategyId>`) — voir [prompt-experiments.md](prompt-experiments.md).

### Exemple

```bash
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{ "name":"runRecipe", "arguments":{
    "recipe":"wardley:map:estimate-chain-components",
    "input":{ "title":"Demo", "components":[], "relations":[] }
  }}
}'
```

---

## Flux non exposes comme outils dedies

Ces flux n'ont pas d'**outil MCP dedie**. Deux cas :
- **Strategie unique** → **deja invocable** via `runCommand` avec son methodId (ci-dessous).
- **Recette multi-etapes sans surface propre** → **deja invocable** via `runRecipe` avec sa ref 3 segments.

_(Les recettes `evaluate-map` et `generate` ont desormais leur outil dedie — voir [evaluateMap](#evaluatemap) et [generateValueChain](#generatevaluechain).)_

### identifyCapability — appelable via runCommand

Decode un nom technique (CRM, Kubernetes, Data Warehouse…) en la **capability sous-jacente** qu'il sert, classifiee par nature (activity / practice / knowledge / data). Appel direct : `runCommand { command: "wardley:map:node:identify:default", input: { name, type?, description?, context? } }`.

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `name` | string | **oui** | Nom ou label du composant (ex: "CRM", "Kubernetes", "Data Warehouse") |
| `type` | enum | non | Type OWM : `anchor`, `component`, `pipeline`, `market`, `ecosystem`. Prioritaire sur l'estimation LLM. |
| `description` | string | non | Description libre du composant |
| `context` | string | non | Contexte d'usage dans la chaine de valeur |

### estimateAnchorEvolution — appelable via runCommand

Estime l'evolution d'un **anchor** (user need, haut de la value chain) via la lentille consumption culture. Retourne une phase discrete 1-4 (Genesis → Commodity). Appel direct : `runCommand { command: "wardley:map:climate:position-anchor-in-evolution:culture-phase", input: { name, context } }` (alias `:default`). _(L'ancienne recette mono-etape `anchor-estimate` a ete supprimee au profit de cet appel direct.)_

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `name` | string | **oui** | Nom du user need (ex: "Hot Beverage", "Urban Mobility") |
| `context` | string | **oui** | Contexte metier (requis — l'evaluation d'un anchor est hautement dependante du contexte) |
| `phase` | integer [1-4] | non | Phase pre-evaluee. Si omise, le LLM l'estime. `1`=Genesis, `2`=Custom, `3`=Product, `4`=Commodity. |

### textToCanonical — recette (via runRecipe)

Convertit un **texte quasi structure** (liste de composants avec positions, DSL approximatif) en `WardleyMap` canonique : `text:lint:default` (LLM, refuse un texte hors sujet) puis `owm:parse:dsl` quand la cible est `owm`. Invocable via `runRecipe { recipe: "render:map:text-to-canonical", input: { text, target? } }` (`target`: `json` par defaut, ou `owm`). Recette `recipes/render/map/text-to-canonical.recipe.json`. Pour la prose libre (description d'un domaine sans structure), utiliser plutot `wardley:map:generate`.
