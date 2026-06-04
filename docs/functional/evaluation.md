# Evaluation (promptfoo)

labre-mcp utilise [promptfoo](https://www.promptfoo.dev/) pour tester la qualite des estimations d'evolution de maniere systematique.

## Configuration

Le fichier `promptfooconfig.yaml` a la racine definit les cas de test, les providers LLM et les assertions.

### Providers configures

`promptfooconfig.yaml` declare plusieurs providers ; ceux actifs dans le bloc `providers:` sont :

| Provider | Modele | Endpoint |
|---|---|---|
| `opencode-zen-kimi-2-5` (https) | `kimi-k2.5` | `https://opencode.ai/zen/v1/chat/completions` |
| `opencode-zen-haiku-4-5` (https) | `claude-haiku-4-5` | `https://opencode.ai/zen/v1/messages` |

Auth via `OPENCODE_API_KEY` (header `Authorization: Bearer` pour kimi, `x-api-key` pour haiku).

> Le `defaultTest.options.providers` reference `file://scripts/claude-eval.mjs` (label `claude-code`), mais le dossier `scripts/` n'existe plus dans le repo — voir la note sous [Script de transformation](#script-de-transformation).

### Cas de test (7 cas)

Les cas couvrent differents types de composants :

| Composant | Contexte | Evolution attendue |
|---|---|---|
| ERP | Gestion d'entreprise | Product/Commodity |
| CRM | Relation client | Product/Commodity |
| LLM | Modele de langage | Custom/Product |
| Wardley Mapping | Methodologie | Custom |
| Electricity (France) | Infrastructure energetique | Commodity |
| Electricity (1900) | Debut de l'electrification | Genesis/Custom |
| Air | Ressource naturelle | Extra-competitif |

### 5 couches d'assertions

| Couche | Nom | Description |
|---|---|---|
| 1 | **In range** | Le score d'evolution est dans les bornes attendues |
| 2 | **Zone** | Competitive (0-1) vs extra-competitive (hors 0-1) |
| 3 | **LLM coherence** | Delta entre estimation LLM directe et s-curve |
| 4 | **Publication coherence** | Delta entre estimation publication et s-curve |
| 5 | **Dominant pub type** | Le type de publication dominant correspond au stade |

## Lancer les evaluations

```bash
# Installer promptfoo (si pas deja fait)
npx promptfoo@latest init

# Lancer les evaluations
npx promptfoo eval

# Voir les resultats dans le navigateur
npx promptfoo view
```

### Via le skill Claude Code

Dans le chat Claude Code :
```
/eval
```

Le skill `eval` (`.claude/skills/eval/SKILL.md`) lance automatiquement les evaluations et affiche les resultats.

## Ajouter un cas de test

### Via le skill

```
/add-eval-case
```

Le skill `add-eval-case` (`.claude/skills/add-eval-case/SKILL.md`) guide la creation d'un nouveau cas de test sans editer manuellement le YAML.

### Manuellement

Ajouter un bloc dans `promptfooconfig.yaml` :

```yaml
tests:
  - vars:
      component: "Docker"
      context: "Containerisation d'applications"
      expected_min: 0.55
      expected_max: 0.80
      expected_zone: "competitive"
    assert:
      - type: javascript
        value: "output.evolution >= 0.55 && output.evolution <= 0.80"
```

## Script de transformation

Chaque cas de test declare `options.transform: file://scripts/s-curve-transform.js`. Ce transform convertit les estimations brutes du LLM (certitude, ubiquity…) en `scurve_evolution` via le modele s-curve, consomme ensuite par les assertions.

> **Chemin a realigner** : `scripts/s-curve-transform.js` n'existe plus tel quel dans le repo (le dossier `scripts/` a ete supprime lors de la migration). La logique s-curve reelle vit desormais sous `src/frameworks/wardley/evolution/_legacy/write/s-curve/` (`s-curve.mts`) et son artefact compile sous `dist/frameworks/wardley/evolution/_legacy/write/s-curve/s-curve-transform.js`. Le `promptfooconfig.yaml` doit etre repointe vers cet artefact (ou un transform regenere) — gap suivi cote outillage eval.

## Bonnes pratiques

- Couvrir les 4 stades d'evolution (Genesis, Custom, Product, Commodity)
- Inclure au moins un composant extra-competitif (social_good ou common_good)
- Tester avec des contextes temporels differents (ex: "Electricity en 1900" vs "Electricity aujourd'hui")
- Verifier la coherence entre strategies (assertion LLM/s-curve delta)
