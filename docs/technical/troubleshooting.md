# Depannage

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
2. Utiliser une seule strategie au lieu de `"all"` : `"strategy": "s-curve"`
3. Verifier la connectivite reseau vers `opencode.ai`

### logprob-distribution error 500

**Cause** : Erreur cote serveur OpenCode (probleme connu avec certains modeles).

**Message** : `Cannot read properties of undefined (reading 'prompt_tokens')`

**Solution** : C'est un probleme intermittent cote OpenCode, pas un bug du projet. Les autres strategies fonctionnent normalement — le consensus est calcule sans cette strategie.

### "Method not found"

**Cause** : Appel d'une methode MCP non supportee.

**Methodes supportees** : `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`

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
# Via variable d'environnement
WARDLEY_VERBOSE=1 npx tsx --env-file=.env src/mcp/mcp-server.mts

# Ou dans le fichier .env
WARDLEY_VERBOSE=1
```

### Test manuel du serveur

Envoyer des messages JSON-RPC sur stdin :

```bash
# Ping
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | npx tsx --env-file=.env src/mcp/mcp-server.mts

# Lister les outils
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx tsx --env-file=.env src/mcp/mcp-server.mts

# Appel complet (initialize + call)
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"estimateEvolution","arguments":{"name":"ERP","strategy":"s-curve","certitude":0.9,"ubiquity":0.85}}}
' | npx tsx --env-file=.env src/mcp/mcp-server.mts
```

### Filtrer les notifications

```bash
# Voir uniquement les notifications de progression
... | npx tsx --env-file=.env src/mcp/mcp-server.mts | grep "notifications/message"

# Voir uniquement les channel notifications
... | npx tsx --env-file=.env src/mcp/mcp-server.mts | grep "claude/channel"
```

### Lancer les tests

```bash
# Tous les tests
pnpm test

# Un fichier specifique (via tsx)
npx tsx --test src/work-on-evolution/routing/classification-gate.test.mts
```

### Visualiser le modele S-curve

Ouvrir `src/work-on-evolution/s-curve/s-curve-visualizer.html` dans un navigateur pour visualiser interactivement le modele dual sigmoide et ajuster les parametres.

Permet d'ajuster les parametres kUpper, kLower, x0, yMin, yMax, nu du modele.

## FAQ

### Pourquoi deux backends LLM ?

Le Claude Agent SDK cree un sous-processus qui entre en conflit avec une session Claude Code active. Quand le serveur tourne dans Claude Code (mode interactif), il utilise OpenCode pour eviter ce conflit. La selection est automatique via la variable `_WARDLEY_NESTED`.

### Pourquoi les notifications ne s'affichent pas dans Claude Code ?

Les notifications standard MCP (`notifications/message`) ne sont pas rendues dans le chat Claude Code. Il faut utiliser les channels (`notifications/claude/channel`) et lancer Claude Code avec :

```bash
claude --dangerously-load-development-channels server:wardley-assistant
```

### Quelle est la difference entre oneshot et guided ?

- **Oneshot** : tous les parametres en un seul appel → evaluation immediate
- **Guided** : conversation multi-tour → questions progressives pour rassembler le contexte

La detection est automatique : si vous fournissez assez de parametres, c'est du oneshot. Sinon, le systeme passe en mode guide.

### Comment ajouter une strategie ?

Creer un fichier `src/work-on-evolution/strategies/capacity/ma-strategy.mts` qui etend `BaseStrategy`. Le registre le decouvre automatiquement. Voir [Extensibilite](extending.md).

### Que signifie "extra-competitif" ?

Un composant avec une evolution < 0 (social_good) ou > 1 (common_good) est hors de l'axe standard des cartes de Wardley. Il n'est pas evalue par les strategies classiques — le systeme renvoie des questions de re-cadrage.
