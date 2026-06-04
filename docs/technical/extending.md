# Extensibilite

> **Convention** : chaque `methodId` suit la grammaire 5 segments
> `domain:tool:sous-domaine:command:strategie@version`. Référence faisant autorité :
> [`../architecture/ast-schema.md`](../architecture/ast-schema.md). Pointeur :
> [strategy-namespace-convention.md](strategy-namespace-convention.md).

## Ajouter une nouvelle strategie

Une stratégie est une classe qui étend le `BaseStrategy` du core
(`src/core/ast/base-strategy.mts`), expose un `static get method()` au format 5 segments,
et implémente `evaluate(input, context)`. Elle est ensuite **enregistrée explicitement**
dans le registry du framework concerné.

### Etape 1 : Creer le fichier

Les stratégies réelles d'évolution vivent sous
`src/frameworks/wardley/evolution/_legacy/write/strategies/…` (le suffixe `_legacy` est
transitoire — voir [roadmap.md](../architecture/roadmap.md), item B2). Exemple :
`src/frameworks/wardley/evolution/_legacy/write/strategies/capacity/ma-strategy.mts` :

```typescript
import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const METHOD_ID = 'wardley:map:climate:position-functional-in-evolution:ma-strategy';

export class MaStrategy extends BaseStrategy {
  // Identifiant unique (grammaire 5 segments — voir ast-schema.md)
  static get method(): string {
    return METHOD_ID;
  }

  async evaluate(input: unknown, _context: RequestContext): Promise<StrategyResult> {
    // Votre logique d'evaluation ici. Retourne la forme gamma de l'AST :
    // { signals, reasoning, insights, result }.
    const capturedAt = new Date().toISOString();
    return {
      signals:   [{ name: 'evolution', value: 0.5, source: 'computed', capturedAt }],
      reasoning: [],
      insights:  [],
      result:    { evolution: 0.5, confidence: 0.7, method: METHOD_ID },
    };
  }
}
```

### Etape 2 : Enregistrer dans le registry du framework

Contrairement à l'ancien système d'auto-découverte, l'enregistrement est **explicite**.
Ajouter la classe dans le registry concerné :

| Framework | Registry |
|---|---|
| Évolution (capacity / solution / anchor) | `src/frameworks/wardley/evolution/registry.mts` |
| Value chain / OWM | `src/frameworks/wardley/chain/registry.mts` |
| Commun (toolbox, layout) | `src/frameworks/common/registry.mts` |

```typescript
import { MaStrategy } from './_legacy/write/strategies/capacity/ma-strategy.mjs';
// ... dans registerEvolutionStrategies(registry) :
registry.register(MaStrategy.method, MaStrategy);
```

Le boot (`src/core/transport/strategy-registry-boot.mts`) appelle chaque
`registerXxxStrategies()` au démarrage du daemon.

### Stratégie mock (placeholder I/O)

Pour matérialiser un `methodId` avant son implémentation réelle, créer un fichier
`*.mock-strategy.mts` et l'enregistrer via `registerMocks` (`src/frameworks/mocks-registry.mts`).
Les 70 mocks sont désactivables au boot via `LABRE_DISABLE_MOCKS=1`. La promotion d'un mock
vers une stratégie réelle est suivie en [roadmap.md](../architecture/roadmap.md) (item B4).

```typescript
// src/frameworks/<...>/default.mock-strategy.mts
import { BaseStrategy, type StrategyResult } from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';

const METHOD_ID = 'common:toolbox:list:emit:default';

export class MockExampleStrategy extends BaseStrategy {
  static get method(): string { return METHOD_ID; }
  async evaluate(_input: unknown, _context: RequestContext): Promise<StrategyResult> {
    const capturedAt = new Date().toISOString();
    return {
      signals:   [{ name: 'mock', value: true, source: 'computed', capturedAt }],
      reasoning: [],
      insights:  [{ text: `mock strategy for ${METHOD_ID}`, by: METHOD_ID, type: 'other' }],
      result:    { mock: true, methodId: METHOD_ID },
    };
  }
}
```

---

## Ajouter une recipe

Une **recipe** orchestre des appels de stratégies par `methodId`. Elle vit dans
`recipes/<domain>/<tool>/<name>.recipe.json` et suit ce schéma :

```json
{
  "schemaVersion": "1.0",
  "name": "ma-recipe",
  "domain": "wardley",
  "tool": "map",
  "description": "Ce que fait la recipe.",
  "steps": [
    {
      "stepId": "identify",
      "tool": "wardley:map:node:identify:default",
      "in": "$.input",
      "out": "$.identified"
    },
    {
      "stepId": "estimate",
      "tool": "wardley:map:climate:position-functional-in-evolution:llm-direct",
      "in": "$.identified.result",
      "out": "$.estimate"
    }
  ],
  "listeners": []
}
```

Chaque `step.tool` est un `methodId` 5 segments résolu dans le strategy registry au runtime.
`in` / `out` sont des chemins JSONPath sur l'état partagé de la recipe.

---

## Ajouter un nouvel outil MCP

Le flow moderne utilise **Zod comme source de verite unique** — le schema Zod genere a la fois le JSON Schema expose au client MCP, le type TypeScript, et la validation runtime. Plus de duplication entre `inputSchema` literal et fonction `validateInput()` manuelle.

> **Convention obligatoire** : tout handler MCP est automatiquement enveloppe par `withMcpDegradation` au niveau du dispatch. En contrepartie, **tout appel a un service externe (LLM, BigQuery, web search, fichier reseau) DOIT passer par `tryDegradeAmbient`** — pas de `try { ... } catch {}` muet. Voir [degradation.md](degradation.md) pour le detail du framework.

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

Creer `src/mcp/mon-outil.tool.mts` (convention `*.tool.mts`, comme `src/mcp/estimate-evolution.tool.mts`) :

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

> Nouvelle dependance externe ? Enregistrez aussi un health-check au boot — voir [degradation.md](degradation.md).

### Etape 3 : Enregistrer dans le daemon

Le câblage d'un outil MCP se fait dans `buildBootRegistry()`, dans
`src/core/transport/labre-daemon.mts` :

```typescript
import { MON_OUTIL_TOOL } from '#mcp/mon-outil.tool.mjs';

export function buildBootRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // ... __ping__, ESTIMATE_EVOLUTION_TOOL ...
  registry.register(MON_OUTIL_TOOL);  // Ajouter ici
  return registry;
}
```

Un outil typiquement délègue son traitement à une **recipe** (voir
[Ajouter une recipe](#ajouter-une-recipe)) plutôt qu'à un handler monolithique. L'élargissement
de la surface d'outils (au-delà de `__ping__` + `estimateEvolution`) est suivi en
[roadmap.md](../architecture/roadmap.md) (item B3).

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
