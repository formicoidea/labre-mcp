# Framework de degradation

WardleyAssistant expose 4 outils MCP qui dependent tous de services externes (LLM, BigQuery, web search). Le framework `src/lib/degradation/` factorise la facon dont ces outils signalent qu'une dependance est tombee — sans interrompre le pipeline ni masquer la panne.

## Pourquoi

Avant le framework, chaque outil avalait silencieusement les pannes (ex. la strategie CPC retournait `0.5` partout sans BigQuery, la web-search retombait sur `unknown` sans signal). Le client recevait un resultat **qui ressemblait a un succes** alors que la moitie de la chaine etait inoperante.

Le framework garantit deux choses :
1. Tout outil MCP retourne le shape `{ ...result, degraded: boolean, degradationEvents: DegradationEvent[] }`.
2. Toute panne d'une dependance externe est tracee dans `degradationEvents` avec une notification MCP `warning` correspondante.

## API publique

Tout est expose via `src/lib/degradation/index.mts` :

| Symbole | Role |
|---|---|
| `Degradable<T>` | Shape enveloppe : `{ result, degraded, degradationEvents }`. |
| `DegradationEvent` | Une observation : `{ source, reason, severity, recoverable, detail?, at }`. |
| `withMcpDegradation(toolName, handler)` | Wrapper standard pour tout handler MCP. **Obligatoire**. |
| `tryDegradeAmbient(source, fn, fallback)` | Remplace tout `try { ... } catch { return fallback }`. Recupere le collector via AsyncLocalStorage. |
| `tryDegrade(collector, source, fn, fallback)` | Variante explicite quand on a deja un collector en main. |
| `DegradationCollector` | Classe de collecte (`record`, `recordError`, `merge`, `wrap`). |
| `registerHealthCheck(source, check)` | Ajoute un health-check au registre process-global. |
| `runHealthCheck(source)` / `runAllHealthChecks()` | Execute un ou tous les checks. |
| `getCurrentCollector()` | Retourne le collector ambient (ou `undefined` hors MCP). |
| `withCollector(collector, fn)` | Etablit un collector ambient pour un sous-arbre d'appels. |

## Convention obligatoire

**Tout nouveau handler d'outil MCP DOIT etre dispatche via `withMcpDegradation`.** Le serveur (`src/mcp/mcp-server.mts`) le fait deja a la couche dispatch — vous n'avez rien a wrapper vous-meme dans le handler. Mais :

- Tout appel a un service externe (LLM, BigQuery, web search, fichier reseau) DOIT passer par `tryDegradeAmbient` (pas de `try { ... } catch {}` muet).
- Toute nouvelle dependance externe DOIT enregistrer un health-check au boot dans `src/mcp/boot-health-checks.mts`.
- Toute strategie / module appele depuis un outil peut acceder au collector via `getCurrentCollector()` — pas besoin de threader le collector dans les signatures.

## Cycle de vie d'une invocation

```
client MCP --tools/call--> mcp-server.mts
                              |
                              v
                       withMcpDegradation(toolName, handler)
                              |
                              | (cree DegradationCollector)
                              | (entre dans AsyncLocalStorage)
                              v
                       handler(args)
                              |
                              v
                       routing / strategies / loaders
                              | (tryDegradeAmbient autour de chaque appel externe)
                              | (getCurrentCollector pour signaler une degradation)
                              v
                       returns payload
                              |
                              v
                       collector.wrap(payload) -> Degradable<T>
                              |
                              v (mcp-server.mts merge degraded + degradationEvents
                              |  comme champs soeurs du payload)
                              v
                       JSON-RPC response
```

## Sources standardisees

Les `source` doivent etre des identifiants stables et courts. Conventions actuelles :

| Source | Signification |
|---|---|
| `bigquery` | Toute interaction avec Google BigQuery (creation client, requete CPC, fetch brevets). |
| `cpc-mapper` / `cpc-mapper:progressive` / `cpc-mapper:llm` | Mapping capability -> codes CPC. |
| `cpc-taxonomy-cache` | Cache local des titres CPC. |
| `patent-indicators` | Calcul des 8 indicateurs purs. |
| `web-search` | Verification web search (Agent SDK query). |
| `llm:claude` / `llm:opencode` / `llm:identify-capability` / `llm:anchor-evolution` | Appels LLM (suffixe optionnel = role). |
| `write:capacity:cpc-evolution` | Erreur inattendue dans le pipeline CPC (safety net). |
| `evaluateMap:<componentName>` | Erreur lors de l'evaluation d'un composant dans `evaluateMap`. |

Quand vous ajoutez une nouvelle dependance, choisissez un identifiant similaire (`<service>` ou `<service>:<sous-action>`).

## Exemples

### Ajouter un health-check

```typescript
// src/mcp/boot-health-checks.mts
registerHealthCheck('redis', () => {
  if (!process.env.REDIS_URL) {
    return { ready: false, reason: 'REDIS_URL not set', detail: { missing: ['REDIS_URL'] } };
  }
  return { ready: true };
});
```

### Envelopper un appel externe

Avant :
```typescript
try {
  return await externalService.fetch(id);
} catch {
  return null;
}
```

Apres :
```typescript
return await tryDegradeAmbient(
  'external-service',
  () => externalService.fetch(id),
  null,
);
```

### Pre-flight au debut d'un pipeline

```typescript
const collector = getCurrentCollector();
if (collector) {
  const event = await runHealthCheck('bigquery');
  if (event) collector.record({ ...event, recoverable: true });
}
```

### Sub-collector pour traitement par lot

```typescript
const parent = getCurrentCollector();
for (const item of items) {
  const sub = new DegradationCollector(`batch:${item.name}`);
  try {
    const result = await withCollector(sub, () => processOne(item));
    results.push({ ...result, degradationEvents: sub.getEvents() });
  } finally {
    if (parent) parent.merge(sub);
  }
}
```

## Cote client MCP

Chaque reponse contient deux champs additionnels :

```json
{
  "evolution": 0.42,
  "confidence": 0.18,
  "...": "...",
  "degraded": true,
  "degradationEvents": [
    {
      "source": "bigquery",
      "reason": "BigQuery not configured (missing: BIGQUERY_PROJECT_ID)",
      "severity": "warning",
      "recoverable": true,
      "detail": { "missing": ["BIGQUERY_PROJECT_ID"] },
      "at": "2026-04-22T10:30:00.000Z"
    }
  ]
}
```

Quand `degraded: true`, le resultat est valide mais une ou plusieurs dependances etaient inaccessibles. Les notifications MCP correspondantes (canal `wardley-assistant`, niveau `warning`) sont aussi emises pour affichage temps reel.

## Tests

Le module est couvert par :
- `src/lib/degradation/registry.test.mts` — registre des health-checks
- `src/lib/degradation/collector.test.mts` — collecte + emission notifications
- `src/lib/degradation/with-degradation.test.mts` — `tryDegrade` / `tryDegradeAmbient`
- `src/lib/degradation/mcp-wrapper.test.mts` — wrapping + preflight
- `src/mcp/mcp-server-dispatch.test.mts` — fusion `degraded` + `degradationEvents` dans la reponse
- `src/work-on-evolution/write/strategies/capacity/cpc-degradation.test.mts` — bout-en-bout sur la strategie CPC

Lancer : `npx tsx --test src/lib/degradation/*.test.mts src/mcp/mcp-server-dispatch.test.mts`.
