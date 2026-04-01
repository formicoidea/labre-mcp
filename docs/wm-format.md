# Format .wm (Online Wardley Maps)

Les cartes de Wardley sont stockees dans des fichiers `.wm` utilisant la syntaxe OWM (Online Wardley Maps), compatible avec [onlinewardleymaps.com](https://onlinewardleymaps.com).

## Syntaxe de base

```
title Mon titre de carte

anchor Nom du composant repere [visibility, maturity]

component Nom du composant [visibility, maturity]

Composant Haut->Composant Bas
Composant A+>Composant B

note Un commentaire [visibility, maturity]

evolve Nom du composant target_maturity

style wardley
```

## Systeme de coordonnees

Chaque composant est positionne par deux coordonnees `[visibility, maturity]` :

### Visibility (axe vertical)

- **0.95** : Utilisateur final / ancre (tout en haut)
- **0.70-0.90** : Composants visibles par l'utilisateur
- **0.30-0.70** : Composants intermediaires
- **0.05-0.30** : Infrastructure (tout en bas)

### Maturity / Evolution (axe horizontal)

| Plage | Stade | Description |
|---|---|---|
| 0.00 – 0.17 | **Genesis** | Nouveau, mal compris, experimental |
| 0.17 – 0.40 | **Custom-Built** | Emergent, necessite de l'expertise |
| 0.40 – 0.70 | **Product (+rental)** | Convergent, differencie par fonctionnalites |
| 0.70 – 1.00 | **Commodity (+utility)** | Standardise, invisible, utilitaire |

## Elements

### Title

```
title Salon de the — Boissons chaudes
```

### Anchor (composant repere)

L'ancre est le composant de plus haut niveau, visible par l'utilisateur final :

```
anchor Boisson Chaude [0.94, 0.8]
```

### Component

```
component Electricite [0.04, 0.95]
component Equipement de Brassage [0.44, 0.71]
component The [0.60, 0.65] label [-20, 10]
```

Le `label [x, y]` optionnel positionne le texte relativement au composant.

### Liens de dependance

```
Boisson Chaude->The Infuse       // Le haut a besoin du bas
Boisson Chaude->Eau Chaude       // Relation de besoin
Equipement+>Electricite          // Lien en pointille
```

- `->` : lien plein (besoin direct)
- `+>` : lien en pointille (besoin indirect ou optionnel)

**Regle fondamentale** : un lien signifie que le composant du dessus a **besoin** du composant du dessous pour fonctionner. Ce n'est jamais une relation d'impact ou de transformation.

### Evolve

Indique une fleche d'evolution (mouvement strategique) :

```
evolve Equipement de Brassage 0.85
```

### Note

```
note Le marche evolue vers la commoditisation [0.30, 0.80]
```

### Pipeline

```
pipeline Composant [0.20, 0.80]
```

### Style

```
style wardley
```

## Exemple complet

```
title Salon de The — Boissons Chaudes

anchor Boisson Chaude [0.94, 0.80]

component Boisson Servie [0.90, 0.85]
component The Infuse [0.75, 0.65]
component Feuilles de The [0.60, 0.55]
component Equipement de Brassage [0.44, 0.71]
component Eau Chaude [0.35, 0.90]
component Electricite [0.04, 0.95]

Boisson Chaude->Boisson Servie
Boisson Servie->The Infuse
The Infuse->Feuilles de The
The Infuse->Eau Chaude
Eau Chaude->Equipement de Brassage
Equipement de Brassage->Electricite

note Fournisseur local de the bio [0.55, 0.45]

style wardley
```

Visualisez cette carte sur [onlinewardleymaps.com](https://onlinewardleymaps.com) en collant ce code dans l'editeur.

## Parsing et generation

### Parsing (`evaluate-map.mjs`)

La fonction `parseWardleyMap(content)` extrait via regex :
- Title, anchors, components (avec coordonnees)
- Liens de dependance (`->`, `+>`)
- Notes, evolve, pipelines
- Contenu brut pour le round-tripping

### Generation (`generate-value-chain.mjs`)

La fonction `generateWmContent(chain, evaluations)` produit un fichier .wm valide :
- Trie les composants par visibility (le plus visible en premier)
- Genere les liens : anchor → top-level, puis dependances
- Style par defaut : `wardley`

## Documentation OWM

Pour la syntaxe complete et les fonctionnalites avancees (submap, annotations, market, etc.) :
- [docs.onlinewardleymaps.com](https://docs.onlinewardleymaps.com/docs)
