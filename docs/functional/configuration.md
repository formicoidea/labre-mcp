# Configuration

## Variables d'environnement

| Variable | Valeur | Description |
|---|---|---|
| `OPENCODE_API_KEY` | `sk-...` | Cle API OpenCode, requise pour toute strategie routee vers un provider `http-api` (par defaut : logprob-distribution) |
| `WARDLEY_LLM_CONFIG` | chemin absolu ou relatif | Override du fichier de configuration LLM. Par defaut : `<racine>/llm.config.json`. |
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
    "opencode":   { "kind": "http-api", "baseUrl": "https://opencode.ai/zen/v1", "apiKeyEnv": "OPENCODE_API_KEY" }
  },
  "strategies": {
    "publication-analysis": { "provider": "claude-sdk", "model": "claude-sonnet-4-6", "effort": "high", "maxBudgetUsd": 0.10 },
    "logprob-distribution": { "provider": "opencode",   "model": "kimi-k2.5", "temperature": 0, "topLogprobs": 5 }
    // ... une entree par strategie
  }
}
```

Regles :

- Les **secrets** ne vivent jamais dans le JSON. Le provider reference l'env var par son nom (`apiKeyEnv`).
- Une strategie absente du JSON tombe automatiquement sur le `defaultProvider`.
- La config est validee **au chargement** : si une strategie necessite une capability (`text`, `structured`, `logprobs`) que le provider assigne ne supporte pas, le demarrage echoue avec un message explicite.

Matrice des capabilities par type de provider :

| Provider kind | text | structured | logprobs |
|---|:---:|:---:|:---:|
| `agent-sdk` | ✓ | ✓ | ✗ |
| `http-api`  | ✓ | ✗ | ✓ |

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
