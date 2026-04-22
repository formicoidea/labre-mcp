# Reference des outils MCP

WardleyAssistant expose **4 outils** via le protocole MCP. Chacun est appele via `tools/call` en JSON-RPC 2.0.

| Outil | Role | Schema Zod |
|---|---|---|
| `estimateEvolution` | Estime l'evolution d'un composant | `src/schemas/estimate-evolution.schema.mts` |
| `evaluateMap` | Evalue et met a jour tous les composants d'un .wm | `src/schemas/evaluate-map.schema.mts` |
| `identifyCapability` | Decode un nom de solution vers sa capability | `src/schemas/identify-capability.schema.mts` |
| `estimateAnchorEvolution` | Estime l'evolution d'un anchor (user need) | `src/schemas/estimate-anchor-evolution.schema.mts` |

Les schemas d'entree exposes au client MCP sont **generes a partir des schemas Zod** (`z.toJSONSchema(schema, { io: 'input' })`). Toute modification d'un schema passe par le fichier `src/schemas/*.schema.mts` correspondant — voir [validation.md](validation.md).

---

## estimateEvolution

Estime la position d'evolution d'un composant sur l'axe de Wardley (0 = Genesis, 1 = Commodity). Supporte de maniere transparente les **solutions nommees** (Kubernetes, Salesforce) et les **capabilities abstraites** (CRM, container orchestration) — le routage est automatique.

### Schema d'entree

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `name` | string | **oui** | Nom du composant (ex: "ERP", "LLM", "Electricity") |
| `context` | string | non | Contexte metier (ex: "Logiciel de gestion pour PME") |
| `description` | string | non | Description libre pour les strategies semantiques |
| `certitude` | number [0-1] | non | Degre de comprehension (0=nouveau, 1=totalement compris). Utilise par s-curve. |
| `ubiquity` | number [0-1] | non | Degre de diffusion (0=rare, 1=ubiquitaire). Utilise par s-curve. |
| `wonder` | number [0-1] | non | Proportion de publications "emerveillement". Utilise par pub-analysis. |
| `build` | number [0-1] | non | Proportion de publications "construction". Utilise par pub-analysis. |
| `operate` | number [0-1] | non | Proportion de publications "exploitation". Utilise par pub-analysis. |
| `usage` | number [0-1] | non | Proportion de publications "usage courant". Utilise par pub-analysis. |
| `space` | enum | non | Pre-classification : `economic`, `social_good`, `common_good`. Si omis, detection automatique. |
| `strategy` | string | non | Strategie a utiliser. `"all"` par defaut. Ou un nom specifique (ex: `"write:capacity:s-curve"`). |
| `mode` | enum | non | `oneshot`, `guided`, `conversational`, `auto`, `default`. Auto-detection par defaut. |
| `sessionState` | string | non | Etat serialise d'une session multi-tour (mode guide). |
| `forceEstimate` | boolean | non | Force l'estimation avec les donnees disponibles (mode guide). `false` par defaut. |
| `pipeline` | boolean | non | Active le mode pipeline enrichi (capability pivot + SotA + legacy). `false` par defaut. |

### Modes d'execution

| Mode | Declenchement | Comportement |
|---|---|---|
| **oneshot** | `mode: "oneshot"` ou parametres suffisants (certitude+ubiquity ou wonder+build+operate+usage) | Evaluation immediate en un seul appel |
| **guided** | `mode: "guided"` ou parametres insuffisants | Conversation multi-tour avec questions progressives |
| **auto** | Par defaut | Detecte le mode selon les parametres fournis |

### Detection automatique du mode

1. Parametre `mode` explicite → utilise ce mode
2. `sessionState` present → guided (reprise de conversation)
3. `space` pre-classifie → oneshot
4. Parametres d'evaluation suffisants → oneshot
5. Sinon → guided

### Exemple — oneshot

```json
{
  "name": "estimateEvolution",
  "arguments": {
    "name": "ERP",
    "context": "Logiciel de gestion integre pour grandes entreprises",
    "mode": "oneshot",
    "space": "economic",
    "certitude": 0.9,
    "ubiquity": 0.85,
    "strategy": "all"
  }
}
```

### Exemple — mode guide (tour 1)

```json
{
  "name": "estimateEvolution",
  "arguments": {
    "name": "LLM",
    "context": "Modele de langage pour generation de texte"
  }
}
```

Reponse : question de la phase suivante + `sessionState` a renvoyer au tour suivant.

### Exemple — mode guide (tour 2)

```json
{
  "name": "estimateEvolution",
  "arguments": {
    "name": "LLM",
    "sessionState": "<etat serialise du tour 1>",
    "certitude": 0.6,
    "ubiquity": 0.5
  }
}
```

### Exemple — solution nommee

```json
{
  "name": "estimateEvolution",
  "arguments": {
    "name": "Kubernetes",
    "context": "Orchestration de conteneurs pour microservices",
    "mode": "oneshot",
    "space": "economic"
  }
}
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
    "write:capacity:s-curve": { "evolution": 0.76, "confidence": 0.85, "method": "write:capacity:s-curve" },
    "write:capacity:llm-direct": { "evolution": 0.72, "confidence": 0.90, "method": "write:capacity:llm-direct" }
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
    "write:solution:properties": {
      "evolution": 0.55,
      "confidence": 0.88,
      "method": "write:solution:properties",
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

## evaluateMap

Evalue tous les composants d'un fichier `.wm` existant et met a jour leurs positions d'evolution.

### Schema d'entree

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `filePath` | string | **oui** | Chemin vers le fichier .wm a evaluer |
| `strategy` | string | non | Strategie a utiliser (`"all"` par defaut) |
| `updateFile` | boolean | non | Met a jour le fichier en place (`true` par defaut) |

### Exemple

```json
{
  "name": "evaluateMap",
  "arguments": {
    "filePath": "maps/myMaps/tea-shop-hot-beverages.wm"
  }
}
```

### Structure de la reponse

```json
{
  "evaluations": {
    "Served Beverage": { "evolution": 0.85, "originalMaturity": 0.85, "delta": 0 },
    "Brewing Equipment": { "evolution": 0.71, "originalMaturity": 0.50, "delta": 0.21 }
  },
  "summary": "8 evaluated, 2 skipped, avg delta 0.12",
  "report": "| Component | Original | New | Delta |\n...",
  "updatedContent": "title Tea Shop...",
  "filePath": "maps/myMaps/tea-shop-hot-beverages.wm"
}
```

---

## identifyCapability

Decode un nom technique (CRM, Kubernetes, Data Warehouse…) en la **capability sous-jacente** qu'il sert, classifiee par nature (activity / practice / knowledge / data). Ne s'applique qu'aux composants de type `component` ou `pipeline` — les types `anchor`, `market`, `ecosystem` sont renvoyes tels quels.

### Schema d'entree

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `name` | string | **oui** | Nom ou label du composant (ex: "CRM", "Kubernetes", "Data Warehouse") |
| `type` | enum | non | Type OWM : `anchor`, `component`, `pipeline`, `market`, `ecosystem`. Prioritaire sur l'estimation LLM. |
| `description` | string | non | Description libre du composant |
| `context` | string | non | Contexte d'usage dans la chaine de valeur |

### Exemple

```json
{
  "name": "identifyCapability",
  "arguments": {
    "name": "Salesforce CRM",
    "description": "Plateforme SaaS de gestion relation client"
  }
}
```

### Structure de la reponse

```json
{
  "type": "component",
  "nature": "activity",
  "capability": "Gestion de la relation client",
  "confidence": 0.92,
  "justification": "Salesforce CRM est une solution ciblant l'activite de CRM.",
  "context": "Plateforme SaaS de gestion relation client",
  "name": "Salesforce CRM"
}
```

---

## estimateAnchorEvolution

Estime l'evolution d'un **anchor** (user need, haut de la value chain) sur l'axe Wardley via la lentille consumption culture (perception utilisateur + perception industrielle). Retourne une phase discrete 1-4 (Genesis → Commodity).

### Schema d'entree

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `name` | string | **oui** | Nom du user need (ex: "Hot Beverage", "Urban Mobility", "Project Management") |
| `context` | string | **oui** | Contexte metier (requis — l'evaluation d'un anchor est hautement dependante du contexte) |
| `phase` | integer [1-4] | non | Phase pre-evaluee. Si omise, le LLM l'estime. `1`=Genesis, `2`=Custom, `3`=Product, `4`=Commodity. |

### Exemple

```json
{
  "name": "estimateAnchorEvolution",
  "arguments": {
    "name": "Hot Beverage",
    "context": "Salon de the dans un centre commercial europeen, clientele urbaine"
  }
}
```

### Structure de la reponse

```json
{
  "name": "Hot Beverage",
  "context": "...",
  "phase": 4,
  "label": "Commodity",
  "evolution": 0.85,
  "justification": "La boisson chaude est un produit de base standardise...",
  "source": "llm",
  "confidence": 0.92
}
```
