# Depannage

## Erreurs courantes

### "Nested MCP server detected — exiting cleanly"

**Cause** : Le serveur detecte qu'il tourne deja dans un sous-processus (variable `_WARDLEY_NESTED=1` heritee).

**Solution** : C'est un comportement normal — le guard anti-recursion fonctionne. Si vous voulez lancer le serveur manuellement, assurez-vous que `_WARDLEY_NESTED` n'est pas dans votre environnement :

```bash
unset _WARDLEY_NESTED
node --env-file=.env src/mcp-server.mjs
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

## Debug

### Activer le mode verbose

```bash
# Via variable d'environnement
WARDLEY_VERBOSE=1 node --env-file=.env src/mcp-server.mjs

# Ou dans le fichier .env
WARDLEY_VERBOSE=1
```

### Test manuel du serveur

Envoyer des messages JSON-RPC sur stdin :

```bash
# Ping
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | node --env-file=.env src/mcp-server.mjs

# Lister les outils
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node --env-file=.env src/mcp-server.mjs

# Appel complet (initialize + call)
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"estimateEvolution","arguments":{"name":"ERP","strategy":"s-curve","certitude":0.9,"ubiquity":0.85}}}
' | node --env-file=.env src/mcp-server.mjs
```

### Filtrer les notifications

```bash
# Voir uniquement les notifications de progression
... | node --env-file=.env src/mcp-server.mjs | grep "notifications/message"

# Voir uniquement les channel notifications
... | node --env-file=.env src/mcp-server.mjs | grep "claude/channel"
```

### Lancer les tests

```bash
# Tous les tests
node --test src/*.test.mjs src/strategies/*.test.mjs

# Un fichier specifique
node --test src/classification-gate.test.mjs

# Tests avec module mocks (Node 22+)
node --test --experimental-test-module-mocks src/evaluate-map-notifications.test.mjs
```

**Note** : Certains tests necessitent `--experimental-test-module-mocks` sous Node.js v22 pour le mocking de modules.

### Visualiser le modele S-curve

Ouvrir `src/evolution/s-curve-visualizer.html` dans un navigateur pour visualiser interactivement le modele dual sigmoide et ajuster les parametres.

### Calibrer les parametres S-curve

```bash
node src/calibrate-s-curve.mjs
```

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

Creer un fichier `src/strategies/ma-strategy.mjs` qui etend `BaseStrategy`. Le registre le decouvre automatiquement. Voir [Extensibilite](extending.md).

### Que signifie "extra-competitif" ?

Un composant avec une evolution < 0 (social_good) ou > 1 (common_good) est hors de l'axe standard des cartes de Wardley. Il n'est pas evalue par les strategies classiques — le systeme renvoie des questions de re-cadrage.
