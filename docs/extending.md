# Extensibilite

## Ajouter une nouvelle strategie

C'est la forme d'extension la plus simple — aucune modification de code existant n'est necessaire.

### Etape 1 : Creer le fichier

Creer `src/strategies/ma-strategy.mjs` :

```javascript
import { BaseStrategy } from './base-strategy.mjs';

export class MaStrategy extends BaseStrategy {
  // Identifiant unique de la strategie
  static get method() {
    return 'ma-strategy';
  }

  // Evaluation du composant
  async evaluate(component) {
    const { name, certitude, ubiquity, description } = component;

    // Votre logique d'evaluation ici
    const evolution = 0.5;
    const confidence = 0.7;

    return BaseStrategy.validateResult({
      evolution,
      confidence,
      method: MaStrategy.method,
    });
  }
}
```

### Etape 2 : C'est tout

Le registre (`strategies/registry.mjs`) decouvre automatiquement tout fichier `*-strategy.mjs` dans le dossier `src/strategies/`. Pas besoin de modifier le registre, le serveur ou les handlers.

### Contrat a respecter

| Methode | Obligatoire | Description |
|---|---|---|
| `static get method()` | Oui | Identifiant unique (string) |
| `evaluate(component)` | Oui | Retourne `EvolutionResult` |

### EvolutionResult

```javascript
{
  evolution: number,    // Position [0-1] ou hors bande
  confidence: number,   // Score [0-1]
  method: string,       // Identifiant de la strategie
  trace: array,         // Etapes de raisonnement (optionnel)
}
```

### Injection de dependances

Si votre strategie a besoin d'un appel LLM, il est injecte via le constructeur ou via les proprietes du composant :

```javascript
async evaluate(component) {
  // L'appel LLM est fourni par l'orchestrateur
  const llmCall = component.llmCall;
  if (llmCall) {
    const response = await llmCall('Mon prompt {{name}}', { name: component.name });
    // ...
  }
}
```

---

## Ajouter une solution strategy

Meme principe que les capability strategies, mais dans le dossier `src/solution-strategies/`.

### Etape 1 : Creer le fichier

Creer `src/solution-strategies/ma-strategy.mjs` :

```javascript
import { SolutionBaseStrategy } from './solution-base-strategy.mjs';

export class MaStrategy extends SolutionBaseStrategy {
  static get method() {
    return 'ma-solution-strategy';
  }

  async evaluate(component) {
    const { name, description } = component;

    // Votre logique d'evaluation ici
    // Doit retourner un SolutionEvolutionResult
    return this.validateSolutionResult({
      evolution: 0.55,
      confidence: 0.80,
      method: MaStrategy.method,
      properties: [], // detail par propriete (optionnel)
    });
  }
}
```

### Etape 2 : C'est tout

Le registre (`solution-strategies/registry.mjs`) decouvre automatiquement tout fichier `*-strategy.mjs` dans `src/solution-strategies/`. Meme mecanisme que les capability strategies.

### Contrat a respecter

| Methode | Obligatoire | Description |
|---|---|---|
| `static get method()` | Oui | Identifiant unique (string) |
| `evaluate(component)` | Oui | Retourne `SolutionEvolutionResult` |

### SolutionEvolutionResult

Etend `EvolutionResult` avec des champs supplementaires :

```javascript
{
  evolution: number,        // Position [0-1]
  confidence: number,       // Score [0-1]
  method: string,           // Identifiant de la strategie
  properties: array,        // Detail par propriete (optionnel)
  stage: string,            // Genesis / Custom / Product / Commodity
  phaseDistribution: object // { 1: n, 2: n, 3: n, 4: n }
}
```

---

## Ajouter un nouvel outil MCP

### Etape 1 : Creer le module

Creer `src/mon-outil.mjs` :

```javascript
// Definition du schema MCP
export const MON_OUTIL_TOOL = {
  name: 'monOutil',
  description: 'Description de mon outil',
  inputSchema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Mon parametre' },
    },
    required: ['param1'],
  },
};

// Handler
export async function handleMonOutil(args) {
  const { param1 } = args;
  // Logique metier
  return { result: `Traite: ${param1}` };
}
```

### Etape 2 : Enregistrer dans le serveur

Modifier `src/mcp-server.mjs` :

```javascript
import { MON_OUTIL_TOOL, handleMonOutil } from './mon-outil.mjs';

const REGISTERED_TOOLS = [
  ESTIMATE_EVOLUTION_TOOL,
  GENERATE_VALUE_CHAIN_TOOL,
  EVALUATE_MAP_TOOL,
  MON_OUTIL_TOOL,  // Ajouter ici
];

const TOOL_HANDLERS = new Map([
  [ESTIMATE_EVOLUTION_TOOL.name, handleEstimateEvolution],
  [GENERATE_VALUE_CHAIN_TOOL.name, handleGenerateValueChain],
  [EVALUATE_MAP_TOOL.name, handleEvaluateMap],
  [MON_OUTIL_TOOL.name, handleMonOutil],  // Ajouter ici
]);
```

### Etape 3 : Ajouter les notifications (optionnel)

```javascript
import { logInfo, logDebug, logError } from './mcp-notifications.mjs';

export async function handleMonOutil(args) {
  logInfo('monOutil', `Starting monOutil for "${args.param1}"...`);
  try {
    // ...
    logInfo('monOutil', `monOutil completed for "${args.param1}"`);
    return result;
  } catch (err) {
    logError('monOutil', `monOutil failed: ${err.message}`);
    throw err;
  }
}
```

---

## Ajouter un backend LLM

### Etape 1 : Creer la fonction d'appel

Ajouter dans `src/llm-call.mjs` :

```javascript
export function createMonBackendCall(config = {}) {
  const { model = 'mon-modele', baseUrl = 'https://api.mon-backend.com/v1' } = config;

  return async function monBackendCall(prompt, variables = {}) {
    const interpolated = interpolate(prompt, variables);
    // Votre logique d'appel API
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: interpolated }] }),
    });
    const data = await response.json();
    return data.choices[0].message.content;
  };
}
```

### Etape 2 : Pour les logprobs

Si votre backend supporte les logprobs :

```javascript
export function createMonBackendLogprobCall(config = {}) {
  return async function (prompt, variables = {}) {
    // ... appel avec logprobs: true
    return {
      text: response.choices[0].message.content,
      logprobs: response.choices[0].logprobs.content.map(t => ({
        token: t.token,
        logprob: t.logprob,
      })),
    };
  };
}
```

---

## Ajouter une langue de notification

### Etape 1 : Ajouter au catalogue

Modifier `src/progress-messages.mjs` — ajouter la langue a chaque message :

```javascript
{
  id: 'tool_start',
  en: 'Starting {{tool}} for "{{component}}"...',
  fr: 'Demarrage de {{tool}} pour "{{component}}"...',
  sv: 'Startar {{tool}} for "{{component}}"...',  // Ajouter ici
}
```

### Etape 2 : Ajouter au detecteur

Modifier `src/language-detect.mjs` — ajouter une empreinte :

```javascript
const FINGERPRINTS = {
  // ... existantes ...
  sv: {
    distinctive: ['och', 'att', 'det', 'som', 'inte', 'med', 'har'],
    ambiguous: ['en', 'av'],
    patterns: [/\b(och|eller|inte)\b/gi],
  },
};
```

---

## Creer un skill Claude Code

Creer un fichier `.claude/skills/mon-skill/SKILL.md` avec le format :

```markdown
---
description: "Description de mon skill pour quand il doit etre declenche"
---

Instructions pour Claude Code quand ce skill est invoque.
Peut contenir des references aux outils MCP, des etapes a suivre, etc.
```

Le skill sera automatiquement disponible via `/mon-skill` dans le chat Claude Code.
