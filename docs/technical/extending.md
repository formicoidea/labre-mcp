# Extensibilite

> **Convention** : chaque `method` suit le format `<mode>:<family>:<strategy>`.
> Voir [strategy-namespace-convention.md](strategy-namespace-convention.md)
> pour le detail de `mode` (read / write / analyze) et `family`
> (capacity / solution / anchor / component / chain).

## Ajouter une nouvelle strategie capability

C'est la forme d'extension la plus simple — aucune modification de code existant n'est necessaire.

### Etape 1 : Creer le fichier

Creer `src/work-on-evolution/write/strategies/capacity/ma-strategy.mts` :

```typescript
import { BaseStrategy } from './base-strategy.mjs';
import type { ComponentInput, EvolutionResult } from '../../../../types/evolution.mjs';

export class MaStrategy extends BaseStrategy {
  // Identifiant unique de la strategie (convention <mode>:<family>:<strategy>)
  static get method(): string {
    return 'write:capacity:ma-strategy';
  }

  // Evaluation du composant
  async evaluate(component: ComponentInput): Promise<EvolutionResult> {
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

Le registre (`src/work-on-evolution/write/strategies/capacity/registry.mts`) decouvre automatiquement tout fichier `*-strategy.mts` dans le dossier. Pas besoin de modifier le registre, le serveur ou les handlers.

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

Meme principe que les capability strategies, mais dans le dossier `src/work-on-evolution/write/strategies/solution/`.

### Etape 1 : Creer le fichier

Creer `src/work-on-evolution/write/strategies/solution/ma-strategy.mts` :

```typescript
import { SolutionBaseStrategy } from './solution-base-strategy.mjs';
import type { SolutionInput, SolutionEvolutionResult } from '../../../../types/solution.mjs';

export class MaStrategy extends SolutionBaseStrategy {
  static get method(): string {
    return 'write:solution:ma-strategy';
  }

  async evaluate(component: SolutionInput): Promise<SolutionEvolutionResult> {
    const { name, description } = component;

    // Votre logique d'evaluation ici
    // Doit retourner un SolutionEvolutionResult
    return SolutionBaseStrategy.validateSolutionResult({
      evolution: 0.55,
      confidence: 0.80,
      method: MaStrategy.method,
      properties: [], // detail par propriete (optionnel)
    });
  }
}
```

### Etape 2 : C'est tout

Le registre (`src/work-on-evolution/write/strategies/solution/registry.mts`) decouvre automatiquement tout fichier `*-strategy.mts` dans le dossier.

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

Le flow moderne utilise **Zod comme source de verite unique** — le schema Zod genere a la fois le JSON Schema expose au client MCP, le type TypeScript, et la validation runtime. Plus de duplication entre `inputSchema` literal et fonction `validateInput()` manuelle.

> **Convention obligatoire** : tout handler MCP est automatiquement enveloppe par `withMcpDegradation` au niveau du dispatch (`src/mcp/mcp-server.mts`). En contrepartie, **tout appel a un service externe (LLM, BigQuery, web search, fichier reseau) DOIT passer par `tryDegradeAmbient`** — pas de `try { ... } catch {}` muet. Voir [degradation.md](degradation.md) pour le detail du framework.

### Etape 1 : Creer le schema Zod

Creer `src/schemas/mon-outil.schema.mts` :

```typescript
import { z } from 'zod';

export const MonOutilInputSchema = z.object({
  param1: z.string().min(1).describe('Mon parametre obligatoire'),
  option: z.number().min(0).max(1).optional().describe('Option numerique [0-1]'),
  mode: z.enum(['fast', 'thorough']).default('fast'),
}).strict();

export type MonOutilInput = z.infer<typeof MonOutilInputSchema>;
```

Les `.describe()` alimentent le champ `description` du JSON Schema genere. `.strict()` refuse les proprietes inconnues.

### Etape 2 : Creer le module tool

Creer `src/mon-outil.mts` :

```typescript
import { z } from 'zod';
import type { McpToolDefinition, JsonSchema } from './types/mcp.mjs';
import { MonOutilInputSchema, type MonOutilInput } from './schemas/mon-outil.schema.mjs';
import { logInfo, logError } from './lib/mcp-notifications.mjs';
import { toErrorMessage } from './lib/errors.mjs';

// Tool definition — le JSON Schema est genere a partir du Zod schema
export const MON_OUTIL_TOOL: McpToolDefinition = {
  name: 'monOutil',
  description: 'Description de mon outil, visible dans l\'autocompletion MCP.',
  inputSchema: z.toJSONSchema(MonOutilInputSchema, { io: 'input' }) as JsonSchema,
};

// Handler : Zod valide les args, lance une ZodError structuree si invalide.
// Le wrapper withMcpDegradation est applique automatiquement par le serveur ;
// il suffit d'envelopper tout appel externe dans tryDegradeAmbient.
import { tryDegradeAmbient } from './lib/degradation/index.mjs';

export async function handleMonOutil(args: Record<string, unknown>): Promise<unknown> {
  const input: MonOutilInput = MonOutilInputSchema.parse(args);
  const TOOL = 'monOutil';

  logInfo(TOOL, `Starting monOutil for "${input.param1}" (mode=${input.mode})...`);

  // Tout appel a une dependance externe passe par tryDegradeAmbient :
  // si elle echoue, le resultat reste valide et la reponse MCP signale
  // degraded:true avec une notification warning correspondante.
  const llmResult = await tryDegradeAmbient(
    'llm:mon-outil',
    () => callLLM(input.param1),
    'fallback',
  );

  return { result: llmResult };
}
```

> Nouvelle dependance externe ? Enregistrez aussi un health-check au boot dans `src/mcp/boot-health-checks.mts` — voir [degradation.md](degradation.md).

### Etape 3 : Enregistrer dans le serveur

Modifier `src/mcp/mcp-server.mts` :

```typescript
import { MON_OUTIL_TOOL, handleMonOutil } from '../mon-outil.mjs';

const REGISTERED_TOOLS: McpToolDefinition[] = [
  ESTIMATE_EVOLUTION_TOOL,
  EVALUATE_MAP_TOOL,
  IDENTIFY_CAPABILITY_TOOL,
  ESTIMATE_ANCHOR_EVOLUTION_TOOL,
  MON_OUTIL_TOOL,  // Ajouter ici
];

const TOOL_HANDLERS: Map<string, ToolHandler> = new Map([
  // ... existants ...
  [MON_OUTIL_TOOL.name, handleMonOutil],  // Ajouter ici
]);
```

### Etape 4 : Exporter via l'API publique (optionnel)

Si le tool doit etre accessible via l'API programmatique, ajouter dans `src/index.mts` :

```typescript
export { MON_OUTIL_TOOL, handleMonOutil } from './mon-outil.mjs';
```

### Pourquoi Zod plutot qu'un JSON Schema literal

- **Une seule source de verite** : le schema Zod definit le JSON Schema client + le type TS + la validation runtime
- **Validation runtime reelle** : `Schema.parse(args)` retourne une `ZodError` structuree (`issues[].path`, `issues[].message`) si l'input est invalide, au lieu d'un crash cryptique plus loin
- **Types inferes** : plus besoin de maintenir une interface TS en parallele
- **Refactoring simplifie** : ajouter un champ = une ligne dans le schema, TS, JSON Schema et validation sont mis a jour automatiquement

Voir [validation.md](validation.md) pour le detail du systeme Zod.

---

## Ajouter un backend LLM

### Etape 1 : Creer la fonction d'appel

Ajouter dans `src/lib/llm/llm-call.mts` :

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

Modifier `src/lib/progress-messages.mts` — ajouter la langue a chaque message :

```javascript
{
  id: 'tool_start',
  en: 'Starting {{tool}} for "{{component}}"...',
  fr: 'Demarrage de {{tool}} pour "{{component}}"...',
  sv: 'Startar {{tool}} for "{{component}}"...',  // Ajouter ici
}
```

### Etape 2 : Ajouter au detecteur

Modifier `src/lib/language-detect.mts` — ajouter une empreinte :

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
