# Configuration

## Variables d'environnement

| Variable | Valeur | Description |
|---|---|---|
| `OPENCODE_API_KEY` | `sk-...` | Cle API OpenCode, requise pour toute strategie routee vers un provider `http-api` (par defaut : logprob-distribution) |
| `COPILOT_GITHUB_TOKEN` | `ghp_...` / `gho_...` | *(Optionnel)* Token GitHub, lu uniquement si une strategie route vers un provider `copilot-sdk`. A defaut, le SDK Copilot bascule sur `gh auth login` / `GH_TOKEN` / `GITHUB_TOKEN`. |
| `WARDLEY_LLM_CONFIG` | chemin absolu ou relatif | Override du fichier de configuration LLM. Par defaut : `<racine>/llm.config.json`. |
| `WARDLEY_PROMPTS_CONFIG` | chemin absolu ou relatif | Override du fichier de configuration des prompts. Par defaut : `<racine>/prompts.config.json`. |
| `LABRE_HTTP_PORT` | entier `1-65535` | Port d'ecoute du daemon HTTP. Par defaut : `6767`. |
| `LABRE_HTTP_HOST` | adresse IP | Adresse de bind du daemon HTTP. Par defaut : `127.0.0.1` (loopback, dev local). Mettre `0.0.0.0` derriere un routeur PaaS (seenode, ...). |
| `LABRE_DISABLE_MOCKS` | `1` | Ne charge que les 15 strategies reelles au boot (exclut les 70 mocks). |
| `WARDLEY_VERBOSE` | `1`, `true`, `yes` | Active les messages debug dans les notifications. Desactive par defaut. |
| `WARDLEY_EVAL_MODE` | `exclusive`, `parallel` | Mode de routage solution/capability. `exclusive` (defaut) : un seul pipeline. `parallel` : les deux pipelines, resultats fusionnes. |
| `_WARDLEY_NESTED` | `1` | **Automatique** — Positionne par le serveur au demarrage. Guard anti-recursion. Ne pas modifier. |

> Les choix de modele et de provider par strategie vivent desormais dans `llm.config.json` a la racine (voir section suivante). `WARDLEY_LLM_MODEL` et `WARDLEY_LOGPROB_MODEL` ont ete supprimes.

## Configuration LLM — llm.config.json

Chaque capacite/strategie du MCP declare independamment son provider (HTTP API ou runtime agentique) et ses parametres d'appel.

> **Fichier par-utilisateur.** `llm.config.json` est **gitignore** — chaque poste choisit son profil (Claude API, Copilot subscription, mix) sans polluer l'historique. A l'installation : `cp llm.config.example.json llm.config.json`, puis adapter. Pour un override supplementaire sans toucher a ce fichier, pointer `WARDLEY_LLM_CONFIG` vers un autre chemin (ex. `./llm.config.local.json`).

Structure :

```json
{
  "defaultProvider": "claude",
  "providers": {
    "claude": { "kind": "agent-sdk" },
    "opencode":   { "kind": "http-api",    "baseUrl": "https://opencode.ai/zen/v1", "apiKeyEnv": "OPENCODE_API_KEY" },
    "copilot":    { "kind": "copilot-sdk", "authEnv": "COPILOT_GITHUB_TOKEN" }
  },
  "strategies": {
    "publication-analysis": { "provider": "claude", "model": "claude-sonnet-4-6", "effort": "high" },
    "logprob-distribution": { "provider": "opencode",   "model": "kimi-k2.5", "temperature": 0, "topLogprobs": 5 }
    // ... une entree par strategie
  }
}
```

Regles :

- Les **secrets** ne vivent jamais dans le JSON. Le provider reference l'env var par son nom (`apiKeyEnv` pour une cle API HTTP, `authEnv` pour un token GitHub Copilot).
- Une strategie absente du JSON tombe automatiquement sur le `defaultProvider`.
- La config est validee **au chargement** : si une strategie necessite une capability (`text`, `structured`, `logprobs`) que le provider assigne ne supporte pas, le demarrage echoue avec un message explicite.
- Un provider declare mais non reference par une strategie n'est jamais instancie — il reste disponible en option sans consommer de credit ni bloquer le demarrage.

Matrice des capabilities par type de provider :

| Provider kind | text | structured | logprobs |
|---|:---:|:---:|:---:|
| `agent-sdk`   | ✓ | ✓ | ✗ |
| `http-api`    | ✓ | ✗ | ✓ |
| `copilot-sdk` | ✓ | ✓ | ✗ |

### Profils de configuration

Trois profils types couvrent les scenarios actuels. Copier-coller le bloc choisi dans `llm.config.json` (apres `cp llm.config.example.json llm.config.json`).

#### Profil 1 — Claude (poste principal, API Anthropic via Agent SDK)

Toutes les strategies passent par Claude via le runtime Agent SDK ; `logprob-distribution` route vers OpenCode pour recuperer les logprobs (Agent SDK ne les expose pas). `copilot` est declare mais inutilise — aucune credit consommee.

```json
{
  "defaultProvider": "claude",
  "providers": {
    "claude":   { "kind": "agent-sdk" },
    "opencode": { "kind": "http-api",    "baseUrl": "https://opencode.ai/zen/v1", "apiKeyEnv": "OPENCODE_API_KEY" },
    "copilot":  { "kind": "copilot-sdk", "authEnv": "COPILOT_GITHUB_TOKEN" }
  },
  "strategies": {
    "publication-analysis": { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "timeline-benchmark":   { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "llm-direct":           { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "cpc-evolution":        { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "cpc-mapper":           { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "low"  },
    "logprob-distribution": { "provider": "opencode", "model": "kimi-k2.5", "temperature": 0, "topLogprobs": 5 },
    "properties-strategy":  { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "anchor-evolution":     { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "identify-capability":  { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "dual-verification":    { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "pipeline-enrichment":  { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" }
  }
}
```

#### Profil 2 — Copilot (poste secondaire, subscription GitHub Copilot)

Toutes les strategies passent par le runtime Copilot (subscription). `COPILOT_GITHUB_TOKEN` dans `.env` ou `gh auth login` prealable. `logprob-distribution` reste sur OpenCode — Copilot SDK n'expose pas de logprobs. `claude` est declare mais inutilise.

```json
{
  "defaultProvider": "copilot",
  "providers": {
    "claude":   { "kind": "agent-sdk" },
    "opencode": { "kind": "http-api",    "baseUrl": "https://opencode.ai/zen/v1", "apiKeyEnv": "OPENCODE_API_KEY" },
    "copilot":  { "kind": "copilot-sdk", "authEnv": "COPILOT_GITHUB_TOKEN" }
  },
  "strategies": {
    "publication-analysis": { "provider": "copilot",  "model": "gpt-5" },
    "timeline-benchmark":   { "provider": "copilot",  "model": "gpt-5" },
    "llm-direct":           { "provider": "copilot",  "model": "gpt-5" },
    "cpc-evolution":        { "provider": "copilot",  "model": "gpt-5" },
    "cpc-mapper":           { "provider": "copilot",  "model": "gpt-5" },
    "logprob-distribution": { "provider": "opencode", "model": "kimi-k2.5", "temperature": 0, "topLogprobs": 5 },
    "properties-strategy":  { "provider": "copilot",  "model": "gpt-5" },
    "anchor-evolution":     { "provider": "copilot",  "model": "gpt-5" },
    "identify-capability":  { "provider": "copilot",  "model": "gpt-5" },
    "dual-verification":    { "provider": "copilot",  "model": "gpt-5" },
    "pipeline-enrichment":  { "provider": "copilot",  "model": "gpt-5" }
  }
}
```

> Modele alternatif : le plan Copilot donne aussi acces a `claude-sonnet-4-6` — remplacer `"model": "gpt-5"` si tu veux conserver la qualite des prompts calibres pour Claude mais facturer via Copilot.

#### Profil 3 — Mixte (reasoning lourd sur Claude, taches courtes sur Copilot)

Mix des deux providers : Claude pour les strategies a fort effort (structured complexes, raisonnement long), Copilot pour les appels courts (ex. `cpc-mapper` low effort), OpenCode pour les logprobs. Interessant quand le user veut limiter la consommation Anthropic sans basculer tout son pipeline.

```json
{
  "defaultProvider": "claude",
  "providers": {
    "claude":   { "kind": "agent-sdk" },
    "opencode": { "kind": "http-api",    "baseUrl": "https://opencode.ai/zen/v1", "apiKeyEnv": "OPENCODE_API_KEY" },
    "copilot":  { "kind": "copilot-sdk", "authEnv": "COPILOT_GITHUB_TOKEN" }
  },
  "strategies": {
    "publication-analysis": { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "timeline-benchmark":   { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "llm-direct":           { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "cpc-evolution":        { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "cpc-mapper":           { "provider": "copilot",  "model": "gpt-5" },
    "logprob-distribution": { "provider": "opencode", "model": "kimi-k2.5", "temperature": 0, "topLogprobs": 5 },
    "properties-strategy":  { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "anchor-evolution":     { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "identify-capability":  { "provider": "copilot",  "model": "gpt-5" },
    "dual-verification":    { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" },
    "pipeline-enrichment":  { "provider": "claude",   "model": "claude-sonnet-4-6", "effort": "high" }
  }
}
```

### Utiliser GitHub Copilot SDK comme provider

Le provider `copilot-sdk` permet de router une strategie vers le runtime agentique de GitHub Copilot CLI. Utile sur un poste qui dispose d'une subscription Copilot mais pas de cle API Anthropic ni de session Claude Code active.

Prerequis :

- Une subscription GitHub Copilot active.
- Le CLI `copilot` installe globalement (`npm i -g @github/copilot`) — le SDK le lance comme sous-processus JSON-RPC.
- Authentification : soit `gh auth login` prealable, soit `COPILOT_GITHUB_TOKEN` exporte dans l'environnement.

Basculer une strategie vers Copilot (exemple : `cpc-mapper`) :

```json
{
  "strategies": {
    "cpc-mapper": { "provider": "copilot", "model": "gpt-5" }
  }
}
```

Limitations :

- Pas de logprobs — la strategie `logprob-distribution` doit rester sur un provider `http-api` dont la reponse expose les logprobs.
- Sortie structuree via "voie B" : le prompt embarque le JSON Schema, le modele repond en texte libre, le code fait `JSON.parse` + validation optionnelle. Moins strict qu'une contrainte `json_schema` native — les prompts complexes peuvent necessiter un retry interne (gere automatiquement).
- Public preview du SDK (`@github/copilot-sdk` 0.2.x) : breaking changes probables, version epinglee strictement dans `package.json`.

## Configuration des prompts — prompts.config.json

Chaque prompt LLM du MCP vit dans `prompts.config.json` a la racine. Les templates longs sont sortis en fichiers `prompts/*.md` diff-friendly et editables sans rebuild. Pour un override local, pointer `WARDLEY_PROMPTS_CONFIG` vers un fichier alternatif (ex. `prompts.config.local.json` gitignore).

Structure :

```json
{
  "identify-capability": {
    "default": {
      "kind": "template",
      "templateFile": "prompts/identify-capability.md",
      "variables": ["component", "description", "context"],
      "parser": { "kind": "custom", "id": "identifyCapability" }
    }
  },
  "cpc-mapper": {
    "pick-class":     { "kind": "template", "templateFile": "prompts/cpc-mapper.pick-class.md", "variables": ["capability"], "parser": { "kind": "custom", "id": "cpcPickClass" } },
    "pick-from-list": { "kind": "template", "templateFile": "prompts/cpc-mapper.pick-from-list.md", "variables": ["capability", "parent_context", "codes_list"], "parser": { "kind": "custom", "id": "cpcPickFromList" } },
    "fallback":       { "kind": "template", "templateFile": "prompts/cpc-mapper.fallback.md", "variables": ["capability"], "parser": { "kind": "custom", "id": "cpcFallback" } }
  }
}
```

Cle de premier niveau = id de strategie. Cle de deuxieme niveau = nom du prompt au sein de la strategie (par defaut `default`, mais une strategie peut avoir plusieurs prompts distincts — cpc-mapper en a trois).

Kinds de prompt :

| `kind` | Description | Champs |
|---|---|---|
| `template` | Texte externe + substitution `{{var}}` | `templateFile`, `variables[]` |
| `function` | Builder TS enregistre via `registerBuilder` | `builderId` *(schema-only, aucun prompt ne l'utilise actuellement — les 16 prompts sont en `template`)* |

Kinds de parser :

| `parser.kind` | Description | Champs |
|---|---|---|
| `custom` | Fonction TS enregistree via `registerParser` | `id` |
| `delimited` | Bloc delimite START/END | `startMarker`, `endMarker` |
| `keyValue` | Schema Zod (reserve usage futur) | `schemaId` |

Regles :

- Les templates utilisent la syntaxe `{{var}}`. Le loader verifie au demarrage que **chaque `{{var}}` du template est declare dans `variables[]`** et inversement (fail-fast sur dérive).
- **Convention snake_case** pour les noms de variables template (uniforme sur les 16 prompts : `context_line`, `exclude_line`, `current_year`, `property_block`, etc.). Les variables locales JS peuvent rester en camelCase et sont mappees vers snake_case au site d'appel `.build({ context_line: contextLine })`.
- Les fins de ligne sont normalisees `\r\n` → `\n` a la lecture (garantit un prompt identique byte-for-byte sous Windows/Linux).
- La cross-validation avec `llm.config.json` est **souple** : certaines strategies (web-search-verification, solution-classification) sont des prompts techniques consommes via un `llmCall` injecte par un parent — pas besoin d'entree LLM dediee.
- `getPrompt(strategy, name)` retourne `{ build, parse }`. Le parser est resolu paresseusement — seul `.parse()` exige que le parser soit enregistre.
- Les parsers sont enregistres au demarrage via `src/lib/prompts/init.mts` (`import '#lib/prompts/init.mjs'`), importe sur le chemin de boot du daemon avant le premier `.parse()`. Chaque `parser.id` declare dans `prompts.config.json` doit pointer vers une fonction enregistree ; sinon `.parse()` throw avec un message explicite pointant la clé manquante.

Runtime API cote code :

```typescript
import { getPrompt } from './lib/prompts/registry.mjs';
// init.mjs est importe une fois au demarrage (sur le chemin de boot du daemon)
// pour que chaque parser.id du JSON soit enregistre avant le premier .parse().

const p = getPrompt('identify-capability');
const prompt = p.build({ component, description, context });
const response = await llmCall(prompt);
const result = p.parse(response, { name: component, type, context });
```

## Test de non-régression des parsers

`src/lib/prompts/registry-parse-equivalence.test.mts` verifie pour chaque parser enregistre que `getPrompt(...).parse(sample, ctx)` produit la meme valeur que l'appel direct `parseXxx(sample, ctx)`. Lock de non-regression byte-for-byte sur le round-trip registry : toute derive silencieuse du registry (cache, resolution paresseuse, etc.) est capturee immediatement par la CI.

## Routage des outils — recipes + strategy registry

> **`tool.config.json` et `WARDLEY_TOOL_CONFIG` ont ete supprimes.** Le routing des outils MCP
> ne passe plus par un fichier de config dedie. Il est desormais decrit par les **recipes**
> (`recipes/<domain>/<tool>/*.recipe.json`) qui orchestrent des appels de strategies par
> `methodId` 5 segments, resolus dans le **strategy registry** au boot. Voir
> [../architecture/recipes.md](../architecture/recipes.md) et
> [../architecture/strategies.md](../architecture/strategies.md).

## Fichier .env

Le fichier `.env` a la racine du projet contient les cles sensibles :

```env
OPENCODE_API_KEY=sk-votre-cle-ici
WARDLEY_VERBOSE=1
```

Il est charge automatiquement par Node.js via le flag `--env-file=.env` dans `.mcp.json`.

## Configuration MCP — .mcp.json

Le fichier `.mcp.json` a la racine enregistre le serveur MCP aupres de Claude Code via HTTP (le daemon ecoute sur localhost:6767) :

```json
{
  "mcpServers": {
    "labre-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:6767/mcp"
    }
  }
}
```

Le daemon HTTP se demarre avec `pnpm mcp` (`tsx src/core/transport/labre-daemon.mts`). Le transport canonique est HTTP — l'ancien serveur stdio a ete supprime (voir [../architecture/transport.md](../architecture/transport.md)).

| Champ | Description |
|---|---|
| `type` | `http` — transport HTTP (le daemon doit etre demarre separement via `pnpm mcp`). |
| `url` | Endpoint JSON-RPC du daemon : `http://127.0.0.1:6767/mcp`. Port surchargeable via `LABRE_HTTP_PORT`. |

> Le daemon HTTP est un processus long-running lance a part (`pnpm mcp`) : `.mcp.json` ne le spawn pas, il s'y connecte. Plus de champs `command` / `args` / `cwd` (specifiques a l'ancien transport stdio).

## Channels Claude Code

Pour activer les notifications de progression dans le chat :

### 1. Capability serveur

Les capabilities annoncées au `initialize` sont déclarées dans `SERVER_CAPABILITIES`
(`src/core/transport/mcp-handler.mts`). Sur la branche de plateformisation, le handler
n'annonce actuellement que `{ tools: {} }` — la capability expérimentale `claude/channel`
n'est pas (encore) recâblée sur le transport HTTP. Tant qu'elle ne l'est pas, les channels
ci-dessous ne sont pas émis. Suivi global de la surface transport en
[../architecture/roadmap.md](../architecture/roadmap.md).

### 2. Lancement avec le flag

```bash
claude --dangerously-load-development-channels server:labre-mcp
```

Ce flag est necessaire car le serveur n'est pas sur l'allowlist officielle Anthropic (feature en preview).

### 3. Prerequisites

- Claude Code >= v2.1.80
- Authentification via claude.ai (pas une cle API Console)
- Pour les organisations Team/Enterprise : channels doit etre active par un admin

## Mode verbose

Le mode verbose controle l'emission des messages `debug` :

| WARDLEY_VERBOSE | Niveaux emis |
|---|---|
| absent / `0` | `info`, `warning`, `error` uniquement |
| `1` / `true` / `yes` | `debug`, `info`, `warning`, `error` |

Activation programmatique :

```javascript
import { setVerbose } from '#lib/mcp-notifications.mjs';
setVerbose(true);
```

## Configuration des skills Claude Code

Les skills sont definis dans `.claude/skills/` :

| Skill | Chemin | Description |
|---|---|---|
| `estimateEvolution` | `.claude/skills/wardley/map/estimateEvolution/SKILL.md` | Estimation d'evolution |
| `evaluateMap` | `.claude/skills/wardley/map/evaluateMap/SKILL.md` | Evaluation de carte .wm |
| `eval` | `.claude/skills/eval/SKILL.md` | Lancement d'evaluations promptfoo |
| `add-eval-case` | `.claude/skills/add-eval-case/SKILL.md` | Ajout de cas de test |

## Deploiement production (seenode)

Le daemon HTTP se deploie sur [seenode](https://seenode.com) via le lien Git natif : l'application seenode est liee au repo GitHub, chaque push sur `master` declenche un redeploiement automatique. Aucun pipeline GitHub Actions n'est requis.

Modele de branches (identique au repo labre) :

- `staging` — branche par defaut du repo. **Toutes les PR pointent vers `staging`.**
- `master` — branche de production. Merger `staging` dans `master` = mise en production (seenode redeploie).

Configuration de l'application seenode :

| Champ | Valeur |
|---|---|
| Build command | `pnpm install --frozen-lockfile && pnpm run build` (le repo est en pnpm : pas de `package-lock.json`, donc `npm ci` echoue ; pnpm est deja present dans l'image seenode) |
| Start command | `npm run mcp:prod` (simple `node dist/...` — pnpm inutile au runtime) |
| Node | >= 20 (champ `engines` du package.json) |

Variables d'environnement a poser dans le dashboard seenode :

| Variable | Valeur |
|---|---|
| `LABRE_HTTP_HOST` | `0.0.0.0` — **obligatoire** : sans elle le daemon binde le loopback et le routeur seenode ne peut pas l'atteindre. |
| `LABRE_HTTP_PORT` | Le port expose par seenode pour l'application. |
| `LABRE_AUTH` + `SUPABASE_URL` (+ `SUPABASE_ANON_KEY`) | Auth JWT du daemon expose publiquement — voir la section remote du README. Ne jamais exposer un daemon sans auth. |
| Autres (`OPENCODE_API_KEY`, `POSTHOG_API_KEY`, ...) | Selon les strategies/features activees, comme en local. |

Verification post-deploiement : `GET https://<app>.seenode.app/health` puis pointer un client MCP sur `https://<app>.seenode.app/mcp` (`"type": "http"`).
