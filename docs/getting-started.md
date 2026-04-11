# Demarrage rapide

## Prerequisites

- **Node.js** >= 18.0.0 (recommande : 22.x)
- **pnpm** 10.21.0 (impose par `packageManager` dans package.json)
- **Cle API OpenCode** (pour le backend kimi-k2.5 et la strategie logprob-distribution)

## Installation

```bash
git clone <repo-url> WardleyAssistant
cd WardleyAssistant
pnpm install
```

## Configuration

Creer un fichier `.env` a la racine :

```env
# Cle API OpenCode (obligatoire pour les strategies utilisant kimi-k2.5)
OPENCODE_API_KEY=sk-votre-cle-ici

# Mode verbose — active les messages debug (optionnel)
# WARDLEY_VERBOSE=1
```

## Verification

### Test ping du serveur MCP

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | node --env-file=.env src/mcp-server.mjs
```

Reponse attendue :
```json
{"jsonrpc":"2.0","id":1,"result":{}}
```

### Lister les outils disponibles

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node --env-file=.env src/mcp-server.mjs
```

## Premier appel — estimateEvolution

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"estimateEvolution","arguments":{"name":"ERP","context":"Logiciel de gestion integre pour PME","mode":"oneshot","space":"economic","certitude":0.9,"ubiquity":0.85,"strategy":"s-curve"}}}
' | node --env-file=.env src/mcp-server.mjs
```

## Utilisation dans Claude Code

Le fichier `.mcp.json` a la racine enregistre le serveur automatiquement :

```json
{
  "mcpServers": {
    "wardley-assistant": {
      "command": "node",
      "args": ["--env-file=.env", "src/mcp-server.mjs"],
      "cwd": "C:\\...\\WardleyAssistant",
      "timeout": 600
    }
  }
}
```

Quand Claude Code demarre dans ce repertoire, le serveur MCP est disponible et les 3 outils apparaissent automatiquement.

### Activer les notifications dans le chat

Pour voir les messages de progression en temps reel dans le chat Claude Code, lancez avec le flag channels :

```bash
claude --dangerously-load-development-channels server:wardley-assistant
```

Voir [Notifications](notifications.md) pour plus de details.

## Scripts npm

| Script | Commande | Description |
|---|---|---|
| `mcp` | `pnpm run mcp` | Demarre le serveur MCP |

## Structure du projet

```
WardleyAssistant/
├── src/
│   ├── mcp-server.mjs              # Serveur MCP (point d'entree)
│   ├── mcp-tool.mjs                # Definition outil estimateEvolution
│   ├── estimate-evolution.mjs       # Pipeline d'estimation (oneshot)
│   ├── evaluate-map.mjs            # Evaluation batch de fichiers .wm
│   ├── generate-value-chain.mjs    # Generation de chaine de valeur
│   ├── classification-gate.mjs     # Gate de classification economique
│   ├── mode-router.mjs             # Routeur oneshot/guided/auto
│   ├── conversation-session.mjs    # Session multi-tour (mode guide)
│   ├── llm-call.mjs                # Interface LLM (Agent SDK + OpenCode)
│   ├── s-curve.mjs                 # Modele mathematique S-curve
│   ├── response-formatter.mjs      # Formatage markdown des resultats
│   ├── mcp-notifications.mjs       # Notifications de progression
│   ├── progress-messages.mjs       # Catalogue i18n (10 langues)
│   ├── language-detect.mjs         # Detection de langue
│   ├── llm-error-handler.mjs       # Classification des erreurs LLM
│   ├── identify-capability.mjs     # Identification de capacite sous-jacente
│   ├── skill-handler.mjs           # Bridge langage naturel → API
│   ├── calibrate-s-curve.mjs       # Calibration parametres S-curve
│   ├── evolution/
│   │   ├── s-curve-visualizer.html # Visualiseur interactif S-curve
│   │   └── ...
│   └── strategies/
│       ├── registry.mjs            # Auto-decouverte des strategies
│       ├── base-strategy.mjs       # Interface abstraite
│       ├── s-curve-strategy.mjs
│       ├── publication-analysis-strategy.mjs
│       ├── timeline-benchmark-strategy.mjs
│       ├── llm-direct-strategy.mjs
│       ├── logprob-distribution-strategy.mjs
│       └── sector-agent-strategy.mjs
├── maps/myMaps/                    # Cartes .wm generees
├── .claude/skills/                 # Skills Claude Code
├── .mcp.json                       # Enregistrement serveur MCP
├── .env                            # Cles API
├── package.json
└── promptfooconfig.yaml            # Configuration d'evaluation
```
