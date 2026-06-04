# Démarrage rapide

labre-mcp est un serveur **MCP** exposé via un **daemon HTTP** (JSON-RPC 2.0) sur `127.0.0.1:6767`.

## Prérequis

- **Node.js** ≥ 18 (recommandé : 22.x)
- **pnpm** 10.21.0 (imposé par `packageManager` dans `package.json`)
- **Clé API OpenCode** — pour le backend kimi-k2.5 et les stratégies LLM (selon `llm.config.json`)

## Installation

```bash
git clone <repo-url> labre-mcp
cd labre-mcp
pnpm install
```

## Configuration

Créer un fichier `.env` à la racine (voir `.env.example`) :

```env
# Clé API OpenCode (selon les providers activés dans llm.config.json)
OPENCODE_API_KEY=sk-votre-cle-ici

# Port du daemon (optionnel, défaut 6767)
# LABRE_HTTP_PORT=6767

# Ne booter que les 15 stratégies réelles (sans les 70 mocks) (optionnel)
# LABRE_DISABLE_MOCKS=1
```

Copier `llm.config.example.json` vers `llm.config.json` et choisir un profil (voir [configuration.md](technical/configuration.md)).

## Démarrer le daemon

```bash
pnpm run dev           # tsx src/core/transport/labre-daemon.mts
```

Sortie attendue sur **stderr** :

```
[labre-mcp] HTTP server listening on http://127.0.0.1:6767 (POST /mcp)
[labre-mcp] Tools registered: __ping__, estimateEvolution
[labre-mcp] Strategies registered (85):
  - common:toolbox:list:emit:default
  - …
```

`Ctrl+C` pour stopper. En prod : `pnpm run build && pnpm run mcp:prod` (`node dist/core/transport/labre-daemon.mjs`).

## Smoke test (transport — sans LLM, gratuit)

Le daemon doit tourner (terminal séparé). Ces 4 appels valident transport + dispatch sans aucun appel LLM. **Tous vérifiés.**

```bash
# 1. Liveness
curl http://127.0.0.1:6767/health
# → {"status":"ok"}

# 2. JSON-RPC ping
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
# → {"jsonrpc":"2.0","id":1,"result":{}}

# 3. Lister les outils exposés
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
# → tools: [ __ping__, estimateEvolution, runCommand ]

# 4. Outil d'écho (chemin tools/call de bout en bout, sans LLM)
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"__ping__","arguments":{"message":"hello"}}}'
# → {"jsonrpc":"2.0","id":3,"result":{"result":{"echoed":{"message":"hello"},"daemon":"labre-mcp"},"degraded":false,"degradationEvents":[]}}
```

> **Enveloppe `Degradable<T>`** : toute réponse `tools/call` est enveloppée par la couche de dégradation (`{ result, degraded, degradationEvents }`). Le **payload métier se lit sous `result.result`**. Les méthodes JSON-RPC `ping`/`tools/list`/`initialize` ne sont pas concernées.

> **Windows / PowerShell** : `curl` est un alias de `Invoke-WebRequest`. Préférer `curl.exe`, et échapper les guillemets internes (`\"`) ou passer le corps JSON via un fichier.

## Premier appel métier — `estimateEvolution` (consomme du LLM/quota)

```bash
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":4,"method":"tools/call",
  "params":{
    "name":"estimateEvolution",
    "arguments":{
      "name":"ERP",
      "context":"Logiciel de gestion intégré pour PME",
      "certitude":0.9,
      "ubiquity":0.85,
      "strategy":"wardley:map:climate:position-functional-in-evolution:s-curve"
    }
  }
}'
```

Le paramètre `strategy` accepte `"auto"` (défaut), `"report"`, ou un **methodId 5 segments** précis (grammaire : [ast-schema.md](architecture/ast-schema.md)). La réponse contient `recipeRunId`, l'AST, la trace d'événements et le chemin de l'artefact sous `~/.labre-mcp/runs/`.

## Appel direct d'une commande — `runCommand`

`runCommand` invoque **n'importe quel methodId** directement (sans recette) et renvoie un `CommandResult` (sortie + enveloppe JSON-labre). L'exemple ci-dessous (`render:wardley-map:owm:parse:dsl`) est déterministe, **sans LLM** :

```bash
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" -d '{
  "jsonrpc":"2.0","id":5,"method":"tools/call",
  "params":{
    "name":"runCommand",
    "arguments":{
      "command":"render:wardley-map:owm:parse:dsl",
      "input":{"dsl":"title Demo\ncomponent Foo [0.5, 0.5]"}
    }
  }
}'
```

> La réponse MCP est enveloppée dans `Degradable<T>` : le `CommandResult` se lit sous **`result.result`** (`{ status, output, envelope, metadata }`). Un methodId inconnu renvoie `status: "error"`. Voir [tools-reference](functional/tools-reference.md#runcommand).

## Utilisation dans Claude Code

`.mcp.json` à la racine enregistre le serveur :

```json
{ "mcpServers": { "labre-mcp": { "type": "http", "url": "http://127.0.0.1:6767/mcp" } } }
```

Le daemon doit tourner (`pnpm run dev`) pour que le client s'y connecte. Les outils apparaissent alors automatiquement.

### Notifications dans le chat

```bash
claude --dangerously-load-development-channels server:labre-mcp
```

Voir [notifications.md](functional/notifications.md).

## Surface actuelle

| | |
|---|---|
| Outils MCP câblés | `estimateEvolution`, `runCommand` (invocation directe de n'importe quel methodId), `__ping__`. Recettes multi-étapes restantes non encore exposées — [roadmap.md](architecture/roadmap.md) B3 |
| Stratégies | 85 enregistrées : 15 réelles + 70 mocks |

## Scripts npm

| Script | Commande | Description |
|---|---|---|
| `dev` / `mcp` | `tsx src/core/transport/labre-daemon.mts` | Démarre le daemon HTTP (dev, hot des `.mts`) |
| `build` | `tsc` | Compile `src/**/*.mts` → `dist/**/*.mjs` |
| `mcp:prod` | `node dist/core/transport/labre-daemon.mjs` | Lance le bundle compilé |
| `typecheck` | `tsc --noEmit` | Vérification TS stricte |
| `test` | `tsx --test "src/**/*.test.mts"` | Tests (⚠️ certains appellent un vrai LLM — voir [AGENT.md](../AGENT.md) hard rule #9) |

## Structure du projet

Voir [tree-map.md](technical/tree-map.md) pour la cartographie complète de `src/`.
