# Expériences de prompts (A/B testing)

Comment lancer une première expérience A/B sur un prompt de stratégie et lire
ses résultats. Contrat technique : [remote-admin-contracts.md](../technical/remote-admin-contracts.md)
(contrat 4).

## Principe

Un flag **multivarié** PostHog nommé `mcp-prompt-<strategyId>` affecte chaque
utilisateur à une variante. **La clé de variante EST le nom du prompt** : quand
un run appelle `getPrompt('<strategyId>')` (prompt `default`), le registre
redirige vers le prompt portant le nom de la variante affectée. Les événements
`mcp_run_end` / `mcp_step_error` portent la propriété
`$feature/mcp-prompt-<strategyId>` — PostHog attribue donc nativement les
métriques de chaque run à sa variante.

## Pas à pas

### 1. Fournir le prompt de la variante

Deux voies :

- **Shipped** : ajouter une entrée nommée dans `prompts.config.json` sous le
  strategyId (kind `template`) + la paire
  `prompts/<strategyId>.<variante>.{system,user}.md`. Exemple : une variante
  `concise` d'`identify-capability` = entrée `identify-capability.concise` +
  paire de fichiers.
- **Bundle distant** : un bundle peut remplacer le TEXTE d'une paire — mais
  uniquement pour une entrée shipped de kind `template` existante
  (`assertBundlePromptsOverridable`). Pour une variante servie par bundle, il
  faut donc que l'entrée shipped `<strategyId>/<variante>` existe (au besoin
  comme placeholder) ; le bundle la shadow ensuite pour la durée de ses runs.

### 2. Créer le flag multivarié dans PostHog

- Clé : `mcp-prompt-<strategyId>` (ex. `mcp-prompt-identify-capability`).
- Variantes : `default` (groupe contrôle — la clé `default` désactive la
  substitution) + une clé par prompt variant (ex. `concise`), avec les
  pourcentages de rollout voulus.
- Une clé de variante qui ne correspond à aucun prompt existant retombe
  **silencieusement** sur `default` (fail-open) : l'expérience ne casse jamais
  un run, mais vérifiez l'orthographe — l'attribution `$feature/` reflétera la
  variante affectée, pas le prompt réellement servi dans ce cas.

### 3. Lancer des runs

L'affectation se fait **une fois par run** de l'outil `runRecipe`, avec
`context.auth.userId` comme distinctId (bucketing stable par utilisateur).

> Daemon non authentifié : tous les appels partagent le distinctId
> `anonymous` et tombent donc dans la **même** variante — une expérience
> n'a de sens qu'avec l'auth activée (`LABRE_AUTH=supabase|oidc`).
> Sans `POSTHOG_API_KEY`, tout le mécanisme est inactif (prompts `default`).

### 4. Lire les résultats

Dans PostHog, comparer les événements `mcp_run_end` ventilés par
`$feature/mcp-prompt-<strategyId>` :

| Propriété | Sens |
|---|---|
| `durationMs` | Latence du run |
| `mcp_step_error` (comptage) | Taux d'échec |
| `llmCalls` | Nombre d'appels LLM du run |
| `inputTokens` / `outputTokens` | Coût tokens (absents si le provider ne les expose pas — copilot-sdk ne compte que les appels) |
| `quality_<name>` | Signaux numériques de l'enveloppe (ex. `quality_confidence`), max 20 clés |

## Limites (v1)

- Seul l'outil **`runRecipe`** est instrumenté (`runCommand` et
  `estimateEvolution` ne sont ni gatés ni attribués).
- La substitution ne s'applique qu'au prompt **`default`** d'une stratégie —
  les noms explicites (`cpc-mapper/pick-class`…) ne sont jamais substitués.
- Fail-open intégral : panne PostHog, flag absent ou variante inconnue →
  comportement nominal (`default`), jamais d'erreur.

# A/B testing de recettes

Symétrique aux prompts, au niveau de la **recette entière** : un run peut être
routé vers une variante de recette au lieu de celle demandée.

## Principe

La **même** clé de flag qui sert de gate rollout — `mcp-recipe-<domain>-<tool>-<name>`
— devient un sélecteur de variante quand sa valeur est une **string** (flag
multivarié). La convention est identique à celle des prompts : **la clé de
variante EST le `name` de la recette** à exécuter à la place (même `domain` +
`tool`). Une valeur **boolean** reste le simple gate on/off (`isRecipeEnabled`).

| Valeur du flag `mcp-recipe-<ref>` | Effet |
|---|---|
| absente / `true` | recette demandée exécutée (nominal) |
| `false` | recette **désactivée** pour cet utilisateur (gate rollout) |
| string `"<autre-name>"` | **variante** : `<autre-name>` exécutée à la place |

## Pas à pas

### 1. Publier la recette variante

La variante est **une recette comme une autre** de même `domain:tool`, résolue
par le chemin `loadRecipe` standard (bundle distant, override projet, ou
shipped). Pour la piloter depuis l'admin sans redéployer : la publier comme
**bundle** (`labre_mcp.strategy_bundles`) sous son `name` de variante. Un bundle
ne peut jamais shadow une recette shipped — la variante porte donc toujours un
slug distinct de la recette demandée.

### 2. Créer le flag multivarié dans PostHog

- Clé : `mcp-recipe-<domain>-<tool>-<name>` (la recette **demandée**).
- Variantes : `control` (= la recette demandée elle-même, ou toute valeur non
  string-de-nom) + une clé par recette variante dont **la valeur = le slug** de
  la variante publiée.

### 3. Lancer des runs

L'affectation se fait une fois par run de `runRecipe`, avec le **même**
`distinctId` que le gate et les variantes de prompt (bucketing cohérent). Daemon
non authentifié → tous en `anonymous` (même variante) : l'expérience n'a de sens
qu'avec l'auth active.

### 4. Lire les résultats

Événements `mcp_run_end` ventilés par `$feature/mcp-recipe-<ref>`. La valeur
attribuée est la recette **réellement servie** (après fail-open) — jamais une
variante qui n'a pas tourné. Mêmes propriétés de performance que pour les
prompts (`durationMs`, `llmCalls`, `quality_<name>`, …).

## Limites & garanties

- Même périmètre que les prompts : seul **`runRecipe`** est instrumenté.
- **Fail-open renforcé** : si la variante nomme une recette introuvable, le run
  exécute la recette **demandée** et n'émet **aucune** attribution `$feature/`
  (contrairement aux prompts où l'attribution peut refléter une variante non
  servie — corrigé ici puisque le swap se fait en un point unique).
- Prompts et recettes se composent : les variantes de prompt s'appliquent
  ensuite aux stratégies de la recette réellement servie.
