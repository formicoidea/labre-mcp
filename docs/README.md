# labre-mcp — Documentation

labre-mcp est un serveur **MCP** (Model Context Protocol) exposé via un **daemon HTTP** (JSON-RPC 2.0, `127.0.0.1:6767`) qui outille les frameworks de pratique stratégique — cartes de Wardley en premier. Les capacités sont adressées par une grammaire de methodId à 5 segments. Projet **TypeScript strict** (`.mts` / ESM) avec **Zod** comme source de vérité runtime.

> **Surface actuelle** : 3 outils MCP câblés — `estimateEvolution`, `runCommand` (invocation directe de n'importe quel methodId) et `__ping__` ; 85 stratégies (15 réelles / 70 mocks). L'écart à la cible est dans [roadmap.md](architecture/roadmap.md).

## Index

### Pivots & architecture (`architecture/`)
| Document | Description |
|---|---|
| [ast-schema.md](architecture/ast-schema.md) | **Pivot** — grammaire 5 segments, vocabulaire de commande ouvert, JSON-labre, contrat de strategy, état real/mock |
| [decisions.md](architecture/decisions.md) | **Pivot** — 25 ADRs (ARCH-01..25) |
| [roadmap.md](architecture/roadmap.md) | Migration en cours (lib/→core, `_legacy/`, câblage outils, mocks→réel) |
| [transport.md](architecture/transport.md) | Daemon HTTP, dispatch JSON-RPC, contexte, auth |
| [recipes.md](architecture/recipes.md) | Schéma de recipe, listeners, auto-fanout, loader shipped+override |
| [strategies.md](architecture/strategies.md) | Registry, contrat BaseStrategy, format `{ signals, reasoning, insights, result }` |
| [persistence.md](architecture/persistence.md) | Artefacts JSON sous `~/.labre-mcp/runs/`, identité projet |

### Onboarding
| Document | Description |
|---|---|
| [Démarrage rapide](getting-started.md) | Installation, daemon, smoke test HTTP, premier appel |

### Référence fonctionnelle (`functional/`)
| Document | Description |
|---|---|
| [Référence des outils](functional/tools-reference.md) | Outils MCP exposés (schémas, paramètres, exemples HTTP) |
| [Stratégies](functional/strategies.md) | Pipelines capability / solution, stratégies réelles |
| [Gate de classification](functional/classification-gate.md) | social_good / common_good / economic |
| [Notifications](functional/notifications.md) | Progression temps réel, i18n, erreurs |
| [Format .wm (OWM)](functional/wm-format.md) | Syntaxe OWM des cartes de Wardley |
| [Évaluation](functional/evaluation.md) | promptfoo : cas de test, assertions |

### Technique (`technical/`)
| Document | Description |
|---|---|
| [tree-map](technical/tree-map.md) | Cartographie de `src/` (source de navigation) |
| [Architecture](technical/architecture.md) | Vue conceptuelle du pipeline |
| [Configuration](technical/configuration.md) | Variables d'env, `llm.config.json`, `.mcp.json` |
| [Validation (Zod)](technical/validation.md) | Schémas Zod, lecture des erreurs |
| [Dégradation](technical/degradation.md) | Framework `Degradable<T>`, health-checks |
| [Extensibilité](technical/extending.md) | Ajouter une stratégie, une recipe, un backend LLM |
| [Convention de namespace](technical/strategy-namespace-convention.md) | → renvoie au pivot ast-schema.md |
| [Dépannage](technical/troubleshooting.md) | Erreurs courantes, debug, FAQ |

## Liens utiles

- [onlinewardleymaps.com](https://onlinewardleymaps.com) — éditeur visuel OWM
- [docs.onlinewardleymaps.com](https://docs.onlinewardleymaps.com/docs) — format OWM
- [modelcontextprotocol.io](https://modelcontextprotocol.io/specification) — spécification MCP
