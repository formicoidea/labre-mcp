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

### Demarrage en dev (via tsx)

```bash
pnpm run dev
```

Sortie attendue sur stderr :
```
[wardley-assistant] MCP server started. Tools: estimateEvolution, generateValueChain, evaluateMap, identifyCapability, estimateAnchorEvolution
```

Ctrl+C pour stopper.

### Build + demarrage en prod (via node dist/)

```bash
pnpm run build       # tsc compile src/**/*.mts vers dist/**/*.mjs
pnpm run mcp:prod    # node dist/mcp/mcp-server.mjs
```

### Test ping du serveur MCP

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | npx tsx --env-file=.env src/mcp/mcp-server.mts
```

Reponse attendue :
```json
{"jsonrpc":"2.0","id":1,"result":{}}
```

### Lister les outils disponibles

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx tsx --env-file=.env src/mcp/mcp-server.mts
```

## Premier appel — estimateEvolution

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"estimateEvolution","arguments":{"name":"ERP","context":"Logiciel de gestion integre pour PME","mode":"oneshot","space":"economic","certitude":0.9,"ubiquity":0.85,"strategy":"s-curve"}}}
' | npx tsx --env-file=.env src/mcp/mcp-server.mts
```

## Utilisation dans Claude Code

Le fichier `.mcp.json` a la racine enregistre le serveur automatiquement :

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

> **Note Windows** : le wrapper `cmd /c` est obligatoire pour que le client MCP puisse invoquer `npx`.

Quand Claude Code demarre dans ce repertoire, le serveur MCP est disponible et les 5 outils apparaissent automatiquement (`estimateEvolution`, `generateValueChain`, `evaluateMap`, `identifyCapability`, `estimateAnchorEvolution`).

### Activer les notifications dans le chat

Pour voir les messages de progression en temps reel dans le chat Claude Code, lancez avec le flag channels :

```bash
claude --dangerously-load-development-channels server:wardley-assistant
```

Voir [Notifications](notifications.md) pour plus de details.

## Scripts npm

| Script | Commande | Description |
|---|---|---|
| `dev` | `pnpm run dev` | Demarre le serveur MCP en dev (tsx, hot-reload des .mts) |
| `mcp` | `pnpm run mcp` | Alias de `dev` |
| `build` | `pnpm run build` | Compile `src/**/*.mts` vers `dist/**/*.mjs` via tsc |
| `mcp:prod` | `pnpm run mcp:prod` | Lance le bundle compile (`node dist/mcp/mcp-server.mjs`) |
| `typecheck` | `pnpm run typecheck` | Verification TS stricte sans emission de code |
| `test` | `pnpm test` | Suite de tests unitaires (`tsx --test src/**/*.test.mts`) |

## Structure du projet

Voir [REPOTREEMAP.md](REPOTREEMAP.md) pour la cartographie complete. Aperçu :

```
WardleyAssistant/
├── src/
│   ├── index.mts                        # API programmatique (re-exports)
│   ├── mcp/                             # Couche MCP (transport JSON-RPC)
│   ├── schemas/                         # Schemas Zod (source de verite)
│   ├── types/                           # Re-exports des types inferes
│   ├── lib/                             # Utilitaires transverses (llm, patent, …)
│   ├── session/                         # Sessions conversationnelles (mode guided)
│   ├── work-on-evolution/               # Outils d'evolution (estimateEvolution, evaluateMap, anchor)
│   │   ├── strategies/capacity/         # 7 strategies capability pluggables
│   │   └── strategies/solution/         # Strategies solution (12-property)
│   └── work-on-value-chain/             # Outils chaîne de valeur (generate, identify)
├── maps/myMaps/                         # Cartes .wm generees
├── .claude/skills/                      # Skills Claude Code
├── .mcp.json                            # Enregistrement serveur MCP
├── .env                                 # Cles API
├── tsconfig.json                        # TypeScript strict: true
├── package.json
└── promptfooconfig.yaml                 # Configuration d'evaluation
```
