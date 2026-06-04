# Systeme de notifications

Le daemon HTTP (`src/core/transport/labre-daemon.mts`) emet des notifications de progression pendant l'execution des outils. Ces notifications informent l'utilisateur en temps reel sur l'avancement du traitement. L'API de notification est exposee par le module `src/lib/mcp-notifications.mts`.

## Double emission

Chaque notification est emise dans deux formats :

1. **`notifications/claude/channel`** — Visible dans le chat Claude Code
2. **`notifications/message`** — Standard MCP, pour les autres clients

```json
// Format channel (Claude Code)
{
  "jsonrpc": "2.0",
  "method": "notifications/claude/channel",
  "params": {
    "content": "Classification de Electricity → economic",
    "meta": { "level": "info", "tool": "estimateEvolution" }
  }
}

// Format standard MCP
{
  "jsonrpc": "2.0",
  "method": "notifications/message",
  "params": {
    "level": "info",
    "logger": "estimateEvolution",
    "data": "Classification de Electricity → economic"
  }
}
```

## Niveaux de log

| Niveau | Quand | Mode verbose | Exemples |
|---|---|---|---|
| `info` | Debut/fin d'outil | Toujours emis | "Starting estimateEvolution for \"ERP\"..." |
| `debug` | Etapes intermediaires | Uniquement si `WARDLEY_VERBOSE=1` | "Running strategy s-curve...", "Input validated..." |
| `warning` | Situations anormales | Toujours emis | Degradation, fallback |
| `error` | Erreurs | Toujours emis | "estimateEvolution failed: timeout" |

## API de notification

```javascript
import { logInfo, logDebug, logError, logWarning, setVerbose, isVerbose } from './lib/mcp-notifications.mjs';

// Toujours emis
logInfo('estimateEvolution', 'Starting evaluation for "ERP"');
logError('estimateEvolution', 'API timeout after 30s');
logWarning('estimateEvolution', 'Fallback to default strategy');

// Uniquement si verbose
logDebug('estimateEvolution', 'Running strategy s-curve on "ERP"...');

// Controle programmatique
setVerbose(true);
console.log(isVerbose()); // true
```

## Detection de langue

Les messages de progression sont automatiquement emis dans la langue de l'utilisateur. La detection se base sur le texte fourni dans les parametres de l'outil (context, description, name).

### Langues supportees

| Code | Langue |
|---|---|
| `en` | Anglais (defaut) |
| `fr` | Francais |
| `es` | Espagnol |
| `de` | Allemand |
| `pt` | Portugais |
| `it` | Italien |
| `nl` | Neerlandais |
| `ja` | Japonais |
| `zh` | Chinois |
| `ko` | Coreen |

### Methode de detection

Le module `src/lib/language-detect.mts` utilise :
- **Empreintes lexicales** : mots distinctifs par langue (ponderation 1 pt) et ambigus (0.3 pt)
- **Patterns** : expressions regulieres specifiques a une langue (2 pts)
- **Plages Unicode** : CJK (chinois), Hiragana/Katakana (japonais), Hangul (coreen) — signaux forts
- **Seuil minimum** : 2+ signaux requis pour declarer une langue

Fallback : anglais si aucune langue n'est detectee avec suffisamment de confiance.

## Catalogue de messages

Le fichier `src/lib/progress-messages.mts` contient 40+ messages localises avec interpolation de variables :

```javascript
// Exemple de message
{
  id: 'tool_start',
  en: 'Starting {{tool}} for "{{component}}"...',
  fr: 'Demarrage de {{tool}} pour "{{component}}"...',
  // ... 8 autres langues
}
```

Variables disponibles : `{{tool}}`, `{{component}}`, `{{strategy}}`, `{{evolution}}`, `{{confidence}}`, `{{model}}`, `{{count}}`, `{{elapsed}}`.

## Gestion des erreurs LLM

Le module `src/lib/llm/llm-error-handler.mts` classe les erreurs LLM en types specifiques :

| Type | Declencheur | Message exemple |
|---|---|---|
| `timeout` | `ETIMEDOUT`, `ESOCKETTIMEDOUT`, `AbortError` | "Timeout lors de l'appel au modele kimi-k2.5" |
| `rate_limit` | HTTP 429, "rate limit" dans le message | "Limite de debit atteinte, reessayez dans quelques instants" |
| `auth` | HTTP 401/403, "unauthorized" | "Erreur d'authentification API" |
| `network` | `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET` | "Erreur reseau : serveur inaccessible" |
| `api_error` | HTTP 500+, erreur API generique | "Erreur API : [details]" |
| `empty_response` | Reponse vide ou non-JSON | "Reponse vide du modele" |
| `generic` | Tout le reste | Message d'erreur original |

### Utilisation

```javascript
import { classifyAndLogLLMError, withLLMErrorLogging } from './lib/llm/llm-error-handler.mjs';

// Classification manuelle
try {
  await callLLM(prompt);
} catch (err) {
  classifyAndLogLLMError(err, 'estimateEvolution');
}

// Wrapper automatique
const result = await withLLMErrorLogging(
  () => callLLM(prompt),
  'estimateEvolution'
);
```

## Setup channels dans Claude Code

Pour que les notifications apparaissent dans le chat :

1. Verifiez que `experimental: { 'claude/channel': {} }` est dans les capabilities du serveur (deja configure)
2. Lancez Claude Code avec :
   ```bash
   claude --dangerously-load-development-channels server:labre-mcp
   ```
3. Reconnectez le MCP : `/mcp` dans le chat

Les messages arrivent dans le contexte Claude comme :
```xml
<channel source="labre-mcp" level="info" tool="estimateEvolution">
Starting estimateEvolution for "ERP"...
</channel>
```
