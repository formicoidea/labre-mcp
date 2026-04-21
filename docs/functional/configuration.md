# Configuration

## Variables d'environnement

| Variable | Valeur | Description |
|---|---|---|
| `OPENCODE_API_KEY` | `sk-...` | Cle API OpenCode, requise pour toute strategie routee vers un provider `http-api` (par defaut : logprob-distribution) |
| `COPILOT_GITHUB_TOKEN` | `ghp_...` / `gho_...` | *(Optionnel)* Token GitHub, lu uniquement si une strategie route vers un provider `copilot-sdk`. A defaut, le SDK Copilot bascule sur `gh auth login` / `GH_TOKEN` / `GITHUB_TOKEN`. |
| `WARDLEY_LLM_CONFIG` | chemin absolu ou relatif | Override du fichier de configuration LLM. Par defaut : `<racine>/llm.config.json`. |
| `WARDLEY_PROMPTS_CONFIG` | chemin absolu ou relatif | Override du fichier de configuration des prompts. Par defaut : `<racine>/prompts.config.json`. |
| `WARDLEY_VERBOSE` | `1`, `true`, `yes` | Active les messages debug dans les notifications. Desactive par defaut. |
| `WARDLEY_EVAL_MODE` | `exclusive`, `parallel` | Mode de routage solution/capability. `exclusive` (defaut) : un seul pipeline. `parallel` : les deux pipelines, resultats fusionnes. |
| `_WARDLEY_NESTED` | `1` | **Automatique** — Positionne par le serveur au demarrage. Guard anti-recursion. Ne pas modifier. |

> Les choix de modele et de provider par strategie vivent desormais dans `llm.config.json` a la racine (voir section suivante). `WARDLEY_LLM_MODEL` et `WARDLEY_LOGPROB_MODEL` ont ete supprimes.

## Configuration LLM — llm.config.json

Chaque capacite/strategie du MCP declare independamment son provider (HTTP API ou runtime agentique) et ses parametres d'appel. Le fichier par defaut est `llm.config.json` a la racine ; pour un override local sans toucher au depot, pointer `WARDLEY_LLM_CONFIG` vers `llm.config.local.json` (gitignore).

Structure :

```json
{
  "defaultProvider": "claude-sdk",
  "providers": {
    "claude-sdk": { "kind": "agent-sdk" },
    "opencode":   { "kind": "http-api",    "baseUrl": "https://opencode.ai/zen/v1", "apiKeyEnv": "OPENCODE_API_KEY" },
    "copilot":    { "kind": "copilot-sdk", "authEnv": "COPILOT_GITHUB_TOKEN" }
  },
  "strategies": {
    "publication-analysis": { "provider": "claude-sdk", "model": "claude-sonnet-4-6", "effort": "high" },
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
- Les parsers sont enregistres au demarrage via `src/lib/prompts/init.mts`, importe en tete de `src/mcp/mcp-server.mts` (`import '../lib/prompts/init.mjs'`). Chaque `parser.id` declare dans `prompts.config.json` doit pointer vers une fonction enregistree ; sinon `.parse()` throw avec un message explicite pointant la clé manquante.

Runtime API cote code :

```typescript
import { getPrompt } from './lib/prompts/registry.mjs';
// init.mjs est importe une fois au demarrage (mcp-server.mts en tete) pour
// que chaque parser.id du JSON soit enregistre avant le premier .parse().

const p = getPrompt('identify-capability');
const prompt = p.build({ component, description, context });
const response = await llmCall(prompt);
const result = p.parse(response, { name: component, type, context });
```

## Test de non-régression des parsers

`src/lib/prompts/registry-parse-equivalence.test.mts` verifie pour chaque parser enregistre que `getPrompt(...).parse(sample, ctx)` produit la meme valeur que l'appel direct `parseXxx(sample, ctx)`. Lock de non-regression byte-for-byte sur le round-trip registry : toute derive silencieuse du registry (cache, resolution paresseuse, etc.) est capturee immediatement par la CI.

## Fichier .env

Le fichier `.env` a la racine du projet contient les cles sensibles :

```env
OPENCODE_API_KEY=sk-votre-cle-ici
WARDLEY_VERBOSE=1
```

Il est charge automatiquement par Node.js via le flag `--env-file=.env` dans `.mcp.json`.

## Configuration MCP — .mcp.json

Le fichier `.mcp.json` a la racine enregistre le serveur MCP aupres de Claude Code :

```json
{
  "mcpServers": {
    "wardley-assistant": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "--env-file=.env", "src/mcp/mcp-server.mts"],
      "cwd": "C:\\...\\WardleyAssistant",
      "timeout": 600
    }
  }
}
```

| Champ | Description |
|---|---|
| `command` | `cmd` sous Windows (wrapper obligatoire pour `npx`). Sous Linux/macOS : `npx` directement. |
| `args` | Lance tsx avec le `.env` puis execute le serveur (`.mts` compile a la volee) |
| `cwd` | Repertoire de travail (chemin absolu) |
| `timeout` | Timeout en secondes (600 = 10 minutes). Necessaire pour les evaluations longues. |

## Channels Claude Code

Pour activer les notifications de progression dans le chat :

### 1. Capability serveur (deja configure)

Le serveur declare la capability channel dans `src/mcp/mcp-server.mts` :

```javascript
const SERVER_CAPABILITIES = {
  tools: {},
  logging: {},
  experimental: {
    'claude/channel': {},
  },
};
```

### 2. Lancement avec le flag

```bash
claude --dangerously-load-development-channels server:wardley-assistant
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
import { setVerbose } from './mcp-notifications.mts';
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
