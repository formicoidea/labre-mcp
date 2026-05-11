# labre-mcp

Serveur MCP (Model Context Protocol) pour l'estimation de la position d'evolution des composants sur les cartes de Wardley. Route automatiquement entre deux pipelines d'evaluation — **capability strategies** (6 strategies pluggables) pour les capacites abstraites et **solution strategies** (12 proprietes Wardley) pour les produits nommes — avec gate de classification economique et modes oneshot/conversationnel.

## Demarrage rapide

```bash
pnpm install
# Configurer OPENCODE_API_KEY dans .env

# Dev (charge les sources .mts via tsx)
pnpm run dev

# Prod (consomme dist/ apres build)
pnpm run build && pnpm run mcp:prod
```

Le serveur est automatiquement disponible dans Claude Code via `.mcp.json`.

> **Note Windows** : `.mcp.json` utilise `cmd /c npx tsx ...` — le wrapper `cmd /c` est requis sous Windows pour exécuter `npx` depuis un client MCP.

## Outils MCP

| Outil | Description |
|---|---|
| `estimateEvolution` | Estime la position d'evolution d'un composant |
| `evaluateMap` | Evalue tous les composants d'un fichier .wm |
| `generateValueChain` | Genere une carte Wardley a partir d'une description metier |

## Documentation

La documentation complete est disponible dans le dossier [`docs/`](docs/README.md) :

- [Demarrage rapide](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Reference des outils](docs/tools-reference.md)
- [Strategies d'evaluation](docs/strategies.md) (capability + solution)
- [Gate de classification](docs/classification-gate.md)
- [Configuration](docs/configuration.md)
- [Notifications](docs/notifications.md)
- [Format .wm](docs/wm-format.md)
- [Evaluation (promptfoo)](docs/evaluation.md)
- [Extensibilite](docs/extending.md)
- [Depannage](docs/troubleshooting.md)
