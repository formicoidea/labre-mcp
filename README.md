# WardleyAssistant

Serveur MCP (Model Context Protocol) pour l'estimation de la position d'evolution des composants sur les cartes de Wardley. Utilise 6 strategies pluggables, une gate de classification economique et supporte les modes oneshot et conversationnel.

## Demarrage rapide

```bash
pnpm install
# Configurer OPENCODE_API_KEY dans .env
```

Le serveur est automatiquement disponible dans Claude Code via `.mcp.json`.

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
- [Strategies d'evaluation](docs/strategies.md)
- [Gate de classification](docs/classification-gate.md)
- [Configuration](docs/configuration.md)
- [Notifications](docs/notifications.md)
- [Format .wm](docs/wm-format.md)
- [Evaluation (promptfoo)](docs/evaluation.md)
- [Extensibilite](docs/extending.md)
- [Depannage](docs/troubleshooting.md)
