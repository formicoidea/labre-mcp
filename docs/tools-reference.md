# Reference des outils MCP

WardleyAssistant expose 3 outils via le protocole MCP. Chacun est appele via `tools/call` en JSON-RPC 2.0.

---

## estimateEvolution

Estime la position d'evolution d'un composant sur l'axe de Wardley (0 = Genesis, 1 = Commodity).

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
| `strategy` | string | non | Strategie a utiliser. `"all"` par defaut. Ou un nom specifique (ex: `"s-curve"`). |
| `mode` | enum | non | `oneshot`, `guided`, `conversational`, `auto`, `default`. Auto-detection par defaut. |
| `sessionState` | string | non | Etat serialise d'une session multi-tour (mode guide). |
| `forceEstimate` | boolean | non | Force l'estimation avec les donnees disponibles (mode guide). |

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

### Structure de la reponse

```json
{
  "mode": "oneshot",
  "modeReason": "explicit mode parameter: \"oneshot\"",
  "classification": {
    "space": "economic",
    "reason": "...",
    "requiresReQuestion": false
  },
  "evaluations": {
    "s-curve": { "evolution": 0.76, "confidence": 0.85, "method": "s-curve" },
    "llm-direct": { "evolution": 0.72, "confidence": 0.90, "method": "llm-direct" }
  },
  "message": "Component \"ERP\" classified as economic. Evaluated with 6 strategy(ies).",
  "formatted": "## Evolution Estimation: ERP\n...",
  "sessionState": null,
  "nextQuestion": null,
  "phase": null
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

## generateValueChain

Genere une carte Wardley (fichier `.wm`) a partir d'une description metier en langage naturel.

### Schema d'entree

| Parametre | Type | Requis | Description |
|---|---|---|---|
| `description` | string | **oui** | Description du contexte metier (ex: "Un salon de the servant des boissons chaudes") |
| `filename` | string | non | Nom du fichier de sortie (auto-genere si omis) |
| `outputDir` | string | non | Repertoire de sortie (`maps/myMaps` par defaut) |
| `strategy` | string | non | Strategie pour l'evaluation des composants (`timeline-benchmark` par defaut) |

### Processus

1. **Decomposition LLM** : Le modele decompose la description en chaine de valeur JSON (anchor + composants + dependances)
2. **Evaluation sequentielle** : Chaque composant est evalue via `estimateEvolutionOneShot`
3. **Generation .wm** : Le contenu OWM est genere avec les coordonnees (visibility, maturity)
4. **Ecriture** : Le fichier est ecrit dans le repertoire de sortie

### Exemple

```json
{
  "name": "generateValueChain",
  "arguments": {
    "description": "Un salon de the servant des boissons chaudes aux clients dans un centre-ville"
  }
}
```

### Structure de la reponse

```json
{
  "wmContent": "title Salon de the\n\nanchor Boisson Chaude [0.94, 0.8]\n...",
  "filePath": "maps/myMaps/salon-de-the.wm",
  "components": ["Boisson Chaude", "The", "Eau", "Electricite"],
  "evaluations": { ... }
}
```
