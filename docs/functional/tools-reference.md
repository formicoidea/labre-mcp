# Reference des outils MCP

labre-mcp tourne comme un **daemon HTTP** (`src/core/transport/labre-daemon.mts`) ecoutant sur `127.0.0.1:6767`. Les outils sont appeles via `POST /mcp` en JSON-RPC 2.0 (`tools/call`). Endpoints complementaires : `GET /health`, `GET /version`, et les methodes JSON-RPC `initialize`, `ping`, `tools/list`, `notifications/*`.

## Surface MCP reellement exposee

**3 outils** sont cables dans `buildBootRegistry()` :

| Outil | Role | Schema Zod |
|---|---|---|
| `estimateEvolution` | Estime l'evolution d'un composant (via la recipe `estimate-component`) | `src/schemas/estimate-evolution.schema.mts` |
| `runCommand` | Invoque **n'importe quel methodId** directement → `CommandResult` (output + enveloppe JSON-labre) | `src/schemas/command.schema.mts` |
| `__ping__` | Smoke tool — echo de l'input, valide le transport | (inline) |

Les schemas d'entree exposes au client MCP sont **generes a partir des schemas Zod** (`z.toJSONSchema(schema, { io: 'input' })`). Toute modification d'un schema passe par le fichier `src/schemas/*.schema.mts` correspondant.

> Les flux nommes `evaluateMap`, `identifyCapability`, `estimateAnchorEvolution` et `generateValueChain` ne sont pas (encore) exposes comme **outils dedies** (roadmap [`../architecture/roadmap.md`](../architecture/roadmap.md) B3). Mais leurs strategies sont **deja appelables directement** via `runCommand` avec le methodId correspondant — voir [Flux appelables via runCommand](#flux-appelables-via-runcommand).

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
| `sessionState` | string | non | Etat serialise d'une session multi-tour. Utilise uniquement en mode `conversational` — renvoyer le `sessionState` de la reponse precedente pour continuer. |
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
2. `sessionState` present → conversational (reprise de conversation)
3. `space` pre-classifie → oneshot
4. Parametres d'evaluation suffisants → oneshot
5. Sinon → conversational

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

Reponse : question de la phase suivante + `sessionState` a renvoyer au tour suivant.

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
        "sessionState": "<etat serialise du tour 1>",
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
  "sessionState": null,
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

> `runCommand` expose toute la surface du catalogue, **mocks compris** (70 stratégies renvoient un insight `mock strategy for <id>`). Les 15 stratégies réelles sont listées dans [ast-schema.md → État d'implémentation](../architecture/ast-schema.md).

---

## Flux non encore exposes comme outils dedies

Ces flux n'ont pas (encore) d'**outil MCP dedie** (roadmap [`../architecture/roadmap.md`](../architecture/roadmap.md) B3). Deux cas :
- **Strategie unique** → **deja invocable** via `runCommand` avec son methodId (ci-dessous).
- **Recette multi-etapes** → necessite le cablage d'un outil dedie (runCommand ne lance qu'**une** commande).

### evaluateMap — recette multi-etapes (pas runCommand)

Evalue tous les composants d'un fichier `.wm` existant et met a jour leurs positions d'evolution. Recette 2 etapes `recipes/wardley/map/evaluate-map.recipe.json` (parse → fan-out estimation) → outil dedie a cabler (B3).

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `filePath` | string | **oui** | Chemin vers le fichier .wm a evaluer |
| `strategy` | string | non | `"auto"` (defaut) route chaque composant vers une strategie par type. `"report"` fan-out multi-strategies. Un methodId specifique (ex: `"wardley:map:climate:position-functional-in-evolution:s-curve"`) force cette strategie sur tous les composants economiques. Les anchors restent routes vers `wardley:map:climate:position-anchor-in-evolution:default`. |
| `updateFile` | boolean | non | Met a jour le fichier en place (`true` par defaut) |

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

### generateValueChain — recette multi-etapes (pas runCommand)

Genere une chaine de valeur (layout pour lisibilite, jamais maturite d'evolution). Recette 4 etapes `recipes/wardley/map/generate.recipe.json` (`value-chain:generate:top-down` → `prevent-collision` → `audit:overlap-check` → `owm:emit`) → outil dedie a cabler (B3). L'etape de generation seule reste appelable via `runCommand { command: "wardley:map:value-chain:generate:top-down" }`.
