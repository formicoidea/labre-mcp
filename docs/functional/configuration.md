# Configuration

## Variables d'environnement

| Variable | Valeur | Description |
|---|---|---|
| `OPENCODE_API_KEY` | `sk-...` | Cle API OpenCode pour le backend kimi-k2.5 (obligatoire pour logprob-distribution) |
| `WARDLEY_VERBOSE` | `1`, `true`, `yes` | Active les messages debug dans les notifications. Desactive par defaut. |
| `WARDLEY_LLM_MODEL` | `claude-sonnet-4-6`, `kimi-k2.5`, etc. | Override du modele LLM (par defaut : `claude-sonnet-4-6` pour Agent SDK, `kimi-k2.5` pour OpenCode) |
| `WARDLEY_LOGPROB_MODEL` | `kimi-k2.5` | Modele pour la strategie logprob-distribution |
| `WARDLEY_EVAL_MODE` | `exclusive`, `parallel` | Mode de routage solution/capability. `exclusive` (defaut) : un seul pipeline. `parallel` : les deux pipelines, resultats fusionnes. |
| `_WARDLEY_NESTED` | `1` | **Automatique** — Positionne par le serveur au demarrage. Guard anti-recursion. Ne pas modifier. |

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
| `generateValueChain` | `.claude/skills/wardley/map/generateValueChain/SKILL.md` | Generation de chaine de valeur |
| `eval` | `.claude/skills/eval/SKILL.md` | Lancement d'evaluations promptfoo |
| `add-eval-case` | `.claude/skills/add-eval-case/SKILL.md` | Ajout de cas de test |
