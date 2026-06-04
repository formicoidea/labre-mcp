# Depannage

## Comprendre `degraded: true` dans une reponse MCP

Toute reponse contient les champs `degraded` (boolean) et `degradationEvents` (array). Quand `degraded === true`, **le resultat est valide mais une ou plusieurs dependances externes etaient inaccessibles** — typiquement le pipeline a utilise des fallbacks neutres et la confiance s'en ressent. Lisez `degradationEvents[]` pour identifier la cause :

| `source` | Que verifier |
|---|---|
| `bigquery` | `BIGQUERY_PROJECT_ID` et `GOOGLE_APPLICATION_CREDENTIALS` dans `.env`. La strategie CPC est inoperante sans ces variables. |
| `cpc-mapper` / `cpc-mapper:progressive` / `cpc-mapper:llm` | LLM injoignable au moment du mapping capability -> codes CPC. Verifier la cle API OpenCode et la connectivite. |
| `cpc-taxonomy-cache` | Cache local des titres CPC indisponible. Non-bloquant — le mapper retombe sur le LLM. |
| `patent-indicators` | Module non chargeable (probleme de build). Verifier `npm run typecheck`. |
| `web-search` | Agent SDK non disponible ou rate-limit. Le routing solution/capability bascule sur le defaut `capability`. |
| `llm:claude` / `llm:opencode` / `llm:identify-capability` / `llm:anchor-evolution` | Erreur LLM (timeout, 401, rate limit, empty response). Voir `detail.error` dans l'event. |
| `cpc-evolution` | Erreur inattendue dans le pipeline CPC (safety net). Le `detail` contient le message original. |
| `evaluateMap:<componentName>` | Une evaluation par-composant a leve une exception. Le composant est marque `skipped` avec la raison. |

Les memes informations apparaissent en notifications MCP (canal `labre-mcp`, niveau `warning`) — affichees en temps reel dans Claude Code. Voir [degradation.md](degradation.md) pour la conception du framework.

## Erreurs courantes

### "Nested MCP server detected — exiting cleanly"

**Cause** : Le serveur detecte qu'il tourne deja dans un sous-processus (variable `_WARDLEY_NESTED=1` heritee).

**Solution** : C'est un comportement normal — le guard anti-recursion fonctionne. Si vous voulez lancer le serveur manuellement, assurez-vous que `_WARDLEY_NESTED` n'est pas dans votre environnement :

```bash
unset _WARDLEY_NESTED
pnpm run dev
```

### "OPENCODE_API_KEY is not set"

**Cause** : La cle API OpenCode n'est pas configuree.

**Solution** : Creer ou verifier le fichier `.env` :

```env
OPENCODE_API_KEY=sk-votre-cle-ici
```

Note : cette cle n'est necessaire que pour les strategies utilisant le backend OpenCode (logprob-distribution, llm-direct quand OpenCode est le backend actif).

### Timeout MCP (outil qui ne repond pas)

**Cause** : Le timeout de 600 secondes dans `.mcp.json` est depasse, ou l'API LLM est lente.

**Solutions** :
1. Augmenter le timeout dans `.mcp.json`
2. Utiliser une seule strategie au lieu de `"report"` : `"strategy": "wardley:map:climate:position-functional-in-evolution:s-curve"`
3. Verifier la connectivite reseau vers `opencode.ai`

### logprob-distribution error 500

**Cause** : Erreur cote serveur OpenCode (probleme connu avec certains modeles).

**Message** : `Cannot read properties of undefined (reading 'prompt_tokens')`

**Solution** : C'est un probleme intermittent cote OpenCode, pas un bug du projet. Les autres strategies fonctionnent normalement — le consensus est calcule sans cette strategie.

### "Method not found"

**Cause** : Appel d'une methode MCP non supportee.

**Methodes supportees** (sur `POST /mcp`) : `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/*`. Le daemon expose aussi `GET /health` et `GET /version`.

### ZodError: Invalid input

**Cause** : Les arguments passes a un outil ne respectent pas le schema Zod. Le handler appelle `Schema.parse(args)` qui leve une `ZodError` structuree.

**Message typique** :

```json
{
  "error": {
    "code": -32602,
    "message": "Invalid input",
    "data": {
      "issues": [
        { "path": ["certitude"], "message": "Number must be less than or equal to 1" },
        { "path": ["name"], "message": "Required" }
      ]
    }
  }
}
```

**Solution** : Lire `issues[].path` (chemin dans l'objet d'entree) et `issues[].message` (regle violee). Le schema de reference est dans `src/schemas/*.schema.mts`. Voir [validation.md](validation.md).

## Debug

### Activer le mode verbose

```bash
# Via variable d'environnement, au lancement du daemon
WARDLEY_VERBOSE=1 pnpm mcp

# Ou dans le fichier .env
WARDLEY_VERBOSE=1
```

### Test manuel du daemon (HTTP)

Le transport est HTTP : démarrer le daemon (`pnpm mcp`, écoute sur `127.0.0.1:6767`),
puis envoyer des requêtes avec `curl`.

```bash
# Health check
curl http://127.0.0.1:6767/health
# → {"status":"ok"}

# Ping (JSON-RPC sur POST /mcp)
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'

# Lister les outils
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Appel d'outil (smoke __ping__)
curl -X POST http://127.0.0.1:6767/mcp -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"__ping__","arguments":{"message":"hello"}}}'
```

### Lancer les tests

```bash
# Tous les tests
pnpm test

# Un fichier specifique (via tsx)
npx tsx --test src/frameworks/wardley/evolution/_legacy/write/routing/classification-gate.test.mts
```

### Visualiser le modele S-curve

Ouvrir `src/frameworks/wardley/evolution/_legacy/write/s-curve/s-curve-visualizer.html` dans un navigateur pour visualiser interactivement le modele dual sigmoide et ajuster les parametres.

Permet d'ajuster les parametres kUpper, kLower, x0, yMin, yMax, nu du modele.

## FAQ

### Pourquoi deux backends LLM ?

Le Claude Agent SDK cree un sous-processus qui entre en conflit avec une session Claude Code active. Quand le serveur tourne dans Claude Code (mode interactif), il utilise OpenCode pour eviter ce conflit. La selection est automatique via la variable `_WARDLEY_NESTED`.

### Pourquoi les notifications ne s'affichent pas dans Claude Code ?

Les notifications standard MCP (`notifications/message`) ne sont pas rendues dans le chat Claude Code. Il faut utiliser les channels (`notifications/claude/channel`) et lancer Claude Code avec :

```bash
claude --dangerously-load-development-channels server:labre-mcp
```

### Quelle est la difference entre oneshot et conversational ?

- **Oneshot** : tous les parametres en un seul appel → evaluation immediate
- **Conversational** : conversation multi-tour → questions progressives pour rassembler le contexte

La detection est automatique avec `mode: "default"` (ou `mode` omis) : si vous fournissez assez de parametres, c'est du oneshot. Sinon, le systeme passe en mode conversational.

### Comment ajouter une strategie ?

Creer une classe qui etend le `BaseStrategy` du core, lui donner un `methodId` 5 segments, puis l'enregistrer dans le registry du framework concerne (`src/frameworks/.../registry.mts`). Voir [Extensibilite](extending.md).

### Que signifie "extra-competitif" ?

Un composant avec une evolution < 0 (social_good) ou > 1 (common_good) est hors de l'axe standard des cartes de Wardley. Il n'est pas evalue par les strategies classiques — le systeme renvoie des questions de re-cadrage.
