# Gate de classification

Avant toute evaluation, chaque composant passe par la gate de classification qui determine son espace economique. Cette gate est **fixe et non-pluggable** (une seule implementation par conception).

## Les 3 espaces economiques

| Espace | Definition | Evolution | Action |
|---|---|---|---|
| **social_good** | Ressource naturelle, non produite ni echangee | < 0 (extra-competitif) | Re-questioning |
| **common_good** | Ressource collective, au-dela du marche | > 1 (extra-competitif) | Re-questioning |
| **economic** | Composant de marche, dynamique concurrentielle | [0, 1] (axe Wardley standard) | Evaluation |

### social_good — Biens sociaux

Ressources naturellement disponibles, non produites par l'activite humaine.

**Exemples** : air, oxygene, lumiere du soleil, gravite, vent, pluie, marees, photosynthese, biodiversite.

**Mots-cles detectes** :
`air`, `oxygen`, `sunlight`, `gravity`, `wind`, `rain`, `weather`, `tide`, `photosynthesis`, `biodiversity`...

**Signaux de contexte** :
`freely available`, `naturally occurring`, `not produced`, `available to all`, `cannot be owned`, `non-excludable`, `non-rivalrous`...

### common_good — Biens communs

Ressources gerees collectivement, au-dela de la logique de marche pure.

**Exemples** : domaine public, education publique, infrastructure publique, Creative Commons, standards ouverts, etat de droit.

**Mots-cles detectes** :
`public domain`, `open knowledge`, `public education`, `public infrastructure`, `creative commons`, `open standard`, `democracy`, `rule of law`...

**Signaux de contexte** :
`collectively managed`, `public ownership`, `taxpayer funded`, `universal access`, `decommodified`...

### economic — Biens economiques

Tout composant qui participe aux dynamiques de marche — c'est le cas standard pour les cartes de Wardley.

**Detection** : Si aucun indicateur de social_good ou common_good n'est declenche.

## Re-questioning

Quand un composant est classifie comme non-economique, le systeme ne l'evalue pas directement. Il renvoie des questions de re-cadrage pour aider l'utilisateur a preciser son intention.

**Exemple pour "Air"** :
> "Vouliez-vous dire l'air comprime industriel plutot que l'air atmospherique ? Si vous parlez de l'air en tant que ressource naturelle, il se situe hors de l'axe d'evolution standard des cartes de Wardley."

## Logique de scoring

Le systeme utilise un score combine :
- **Correspondance de nom** (signal fort) : le nom du composant correspond a un mot-cle
- **Signaux de contexte** (signal moyen) : le contexte contient des indicateurs
- **Score combine** : nom + contexte ensemble (signal modere)
- **Seuil** : 2+ signaux contextuels sans correspondance de nom = signal faible

## API

```javascript
import { classifyComponent, buildReQuestions } from './classification-gate.mts';

const result = classifyComponent('Air', 'Oxygene atmospherique pour la respiration');
// → { space: 'social_good', reason: '...', requiresReQuestion: true }

const questions = buildReQuestions(result, 'Air');
// → ["Vouliez-vous dire...", "Si vous parlez de..."]
```

## Bypass

Le parametre `space` de l'outil `estimateEvolution` permet de bypasser la gate :

```json
{ "name": "Air", "space": "economic", "certitude": 0.95, "ubiquity": 0.99 }
```

Avec `space: "economic"`, la gate est ignoree et l'evaluation procede directement.
