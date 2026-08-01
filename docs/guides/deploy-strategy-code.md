# Déployer une stratégie par le code (GitHub)

Pour qui **n'a pas accès à la console admin Labre** : livrer une stratégie — y
compris une stratégie à plusieurs prompts qui s'appuie sur une recette — par une
**pull request sur ce dépôt**, puis une release.

> Tu as accès à l'admin Labre ? Le **chemin bundle** est plus court (pas de PR,
> pas de release, et il débloque l'A/B testing) — voir la section **Framework
> MCP → Strategies → Guide** de la console admin. Ce guide-ci couvre le chemin
> code, complémentaire.

## Les deux chemins

| | Chemin **code** (ce guide) | Chemin **bundle** (admin) |
|---|---|---|
| Pour quoi | une **nouvelle logique** d'évaluation (un `methodId` qui n'existe pas encore) | **composer** des `methodId` existants : recette + texte de prompts |
| Comment | PR sur `labre-mcp` → merge → release npm | upload d'un bundle dans la console admin |
| Qui | développeur (accès repo) | non-développeur (accès admin) |
| A/B testing | **non** au runtime (voir plus bas) | oui, via flags PostHog sans redéploiement |

Si ta stratégie n'est en fait qu'une **orchestration de méthodes déjà livrées**
(mêmes `methodId`, prompts ajustés), tu n'as **pas** besoin de ce chemin : c'est
un bundle. Ce guide vaut dès qu'il faut du **code neuf**.

## Prérequis

- Accès en écriture au dépôt `labre-mcp` (pour ouvrir une PR).
- Node ≥ 20, `npm install` fait.
- Conventions du repo : [AGENT.md](../../AGENT.md) (`.mts`, commits en anglais,
  typage strict, prompts scindés system/user).

## Le scénario : une stratégie à plusieurs prompts + une recette

### 1. Écrire la (ou les) stratégie(s)

Une stratégie est une classe `BaseStrategy` avec un `methodId` 5 segments et un
`evaluate(input, context)`. Détail complet, avec exemple et enregistrement dans
le registry : [technical/extending.md § Ajouter une nouvelle stratégie](../technical/extending.md#ajouter-une-nouvelle-strategie).

> Tu réutilises des `methodId` déjà présents ? Saute cette étape — ta recette
> les référencera directement.

### 2. Ajouter les prompts (paires scindées)

Chaque prompt est **obligatoirement** une paire `*.system.md` (statique, zéro
`{{variable}}`) + `*.user.md` (variables uniquement), enregistrée dans
`prompts.config.json` sous l'id de stratégie. Une stratégie à plusieurs prompts
= plusieurs entrées nommées. Convention et validation :
[technical/configuration.md § Configuration des prompts](../technical/configuration.md#configuration-des-prompts--promptsconfigjson).

### 3. Écrire la recette

Une recette orchestre des `methodId` par étapes, dans
`recipes/<domain>/<tool>/<name>.recipe.json`. Chaque `step.tool` est un
`methodId` résolu au runtime ; `in`/`out` sont des chemins JSONPath sur l'état
partagé. Schéma, listeners et auto-fanout :
[architecture/recipes.md](../architecture/recipes.md) et l'exemple de
[technical/extending.md § Ajouter une recipe](../technical/extending.md#ajouter-une-recipe).

### 4. Enregistrer les stratégies

L'enregistrement est **explicite** (pas d'auto-découverte) : ajouter la classe
dans le registry du framework concerné, appelé au boot. Table des registres :
[technical/extending.md § Enregistrer dans le registry](../technical/extending.md#etape-2--enregistrer-dans-le-registry-du-framework).

### 5. Tester

Test unitaire de la stratégie (forme `{ signals, reasoning, insights, result }`)
et, si utile, un test de bout en bout de la recette (voir les tests existants
sous `src/**/*.test.mts`). Ne lance pas la suite complète en boucle : certains
tests d'intégration appellent de vrais LLM (cf. [AGENT.md](../../AGENT.md)).

### 6. PR → merge → release

Ouvrir la PR **vers `staging`**. Après merge, la stratégie est livrée à la
prochaine **release npm** (`@formicoidea/labre-mcp`) ; le daemon la charge au
démarrage de la version publiée. Tant que la release n'est pas déployée, la
stratégie n'est pas disponible en production.

## A/B testing sur ce chemin

L'A/B testing **runtime** (prompts et recettes) se pilote par des flags PostHog
**créés dans la console admin** — donc **indisponible** si tu n'as que le repo.
Deux options :

- **Hors-ligne, avant de merger** : comparer des variantes de prompt localement
  avec promptfoo — voir [functional/evaluation.md](../functional/evaluation.md).
  C'est le substitut naturel de l'A/B pour le chemin code.
- **Plus tard, avec un accès admin** : tes prompts et ta recette *shipped*
  deviennent la baseline ; l'expérience se pilote alors côté admin sans
  retoucher le code (flags `mcp-prompt-<strategyId>` et
  `mcp-recipe-<domain>-<tool>-<name>`). Mécanique complète :
  [functional/prompt-experiments.md](../functional/prompt-experiments.md).

## Récapitulatif du partage de responsabilité

- **Logique neuve** → code, ici (PR + release). Un développeur, une fois.
- **Composition / réglage de prompts** sur des méthodes existantes → bundle,
  côté admin, sans PR. Un non-développeur, en itération.

Un même besoin se répartit souvent ainsi : le développeur livre la ou les
stratégies par PR une première fois, puis l'itération prompts/recette/A-B se
fait par bundles côté admin, sans jamais retoucher le code.
