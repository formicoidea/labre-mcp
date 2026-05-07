# WardleyAssistant — Documentation

WardleyAssistant est un serveur MCP (Model Context Protocol) qui estime la position d'evolution des composants sur une Wardley Map. Il expose **4 outils** via JSON-RPC 2.0 sur stdio et route automatiquement entre deux pipelines d'evaluation :

- **Capability strategies** (7 strategies pluggables, y compris cpc-evolution via BigQuery) pour les capacites abstraites
- **Solution strategies** (12 proprietes Wardley) pour les produits/solutions nommes

Le projet est en **TypeScript strict** (`.mts` / ESM) avec **Zod** comme source de verite unique pour les schemas d'entree (types + validation runtime + JSON Schema MCP generes depuis un seul schema).

Le routage est transparent : detection automatique via naming, LLM et web search.

## Architecture simplifiee

```mermaid
flowchart TD
    MCP["src/mcp/mcp-server.mts\nJSON-RPC 2.0 stdio"]
    MCP --> EE["estimateEvolution"]
    MCP --> EM["evaluateMap"]
    MCP --> IC["identifyCapability"]
    MCP --> AN["estimateAnchorEvolution"]

    EE & EM & IC & AN --> Z["Zod validation\nsrc/schemas/*.schema.mts"]
    Z --> CG["Classification Gate\nsocial_good / common_good / economic"]
    CG --> MR["Mode Router\noneshot / conversational / default"]
    MR --> SCR["Solution/Capability Router"]

    SCR -->|"solution"| SS["Solution Strategies\n12 proprietes Wardley"]
    SCR -->|"capability"| CS["Capability Strategies\ns-curve, pub-analysis, timeline,\nllm-direct, logprob, sector-agent"]

    SS & CS --> RF["Response Formatter"]
    RF --> N["Notifications"]
```

## Table des matieres

| Document | Description |
|---|---|
| [Demarrage rapide](getting-started.md) | Prerequisites, installation, premier appel |
| [Architecture](architecture.md) | Pipeline, flux de donnees, modules |
| [Reference des outils](tools-reference.md) | Les 4 outils MCP (schemas, parametres, exemples) |
| [Validation (Zod)](validation.md) | Schemas Zod, source de verite unique, lecture des erreurs |
| [Strategies](strategies.md) | Capability (7 strategies) et Solution (12 proprietes Wardley) |
| [Gate de classification](classification-gate.md) | Filtrage social_good / common_good / economic |
| [Configuration](configuration.md) | Variables d'environnement, .mcp.json, channels |
| [Notifications](notifications.md) | Progression temps reel, i18n, gestion d'erreurs |
| [Format .wm](wm-format.md) | Syntaxe OWM pour les cartes de Wardley |
| [Evaluation](evaluation.md) | Framework promptfoo, cas de test, assertions |
| [Extensibilite](extending.md) | Ajouter une strategie, un outil, un backend LLM |
| [Depannage](troubleshooting.md) | Erreurs courantes, debug, FAQ |

## Liens utiles

- [onlinewardleymaps.com](https://onlinewardleymaps.com) — Editeur visuel de cartes OWM
- [docs.onlinewardleymaps.com](https://docs.onlinewardleymaps.com/docs) — Documentation du format OWM
- [modelcontextprotocol.io](https://modelcontextprotocol.io/specification) — Specification MCP
