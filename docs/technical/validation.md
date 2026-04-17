# Validation — Zod comme source de vérité unique

Depuis la migration TS + Zod (avril 2026), tous les schémas du projet sont définis **une seule fois** via Zod. À partir du schéma Zod, on dérive :

- Le **type TypeScript** via `z.infer<typeof Schema>` (statique, compile time)
- La **validation runtime** via `Schema.parse(args)` (dynamique, limite d'exécution)
- Le **JSON Schema** exposé au client MCP via `z.toJSONSchema(Schema, { io: 'input' })` (publié par `tools/list`)

Plus aucune duplication entre interface TS, fonction `validateInput()` manuelle et `inputSchema` littéral.

---

## Les 4 familles de schémas

Tous les schémas vivent dans `src/schemas/*.schema.mts`.

| Famille | Fichiers | Rôle |
|---|---|---|
| **Tool inputs** (4) | `estimate-evolution.schema.mts`, `evaluate-map.schema.mts`, `identify-capability.schema.mts`, `estimate-anchor-evolution.schema.mts` | Entrée des 4 outils MCP — schéma publié au client + parsé à l'appel |
| **Inputs** | `inputs.schema.mts` | `ComponentInput`, `SolutionInput`, `PhaseDistribution` + primitives (`CapabilityNature`, `WardleyPhase`, `PhaseLabel`) — objets métier partagés |
| **Results** | `results.schema.mts` | `EvolutionResult`, `PropertyEvaluation`, `SolutionEvolutionResult` — sorties des stratégies |
| **Patent** | `patent.schema.mts` | `PatentDataSchema` + 8 sous-shapes. Frontière BigQuery / mock — valide les données entrantes d'une source externe |
| **Parsed LLM** | `parsed-llm.schema.mts` | Schémas de sortie des parsers LLM — garantit la forme de ce qu'on reçoit d'un modèle |

---

## Pattern typique dans un handler

```typescript
import { z } from 'zod';
import { MonOutilInputSchema, type MonOutilInput } from './schemas/mon-outil.schema.mjs';

export async function handleMonOutil(args: Record<string, unknown>): Promise<unknown> {
  // 1. Parse — lève une ZodError structurée si invalide
  const input: MonOutilInput = MonOutilInputSchema.parse(args);

  // 2. À partir d'ici, `input` est strictement typé (z.infer)
  //    Pas de validation ad hoc, pas de cast, pas de `if (!args.name) throw`.
  return doTheWork(input);
}
```

---

## `.parse()` vs `.safeParse()`

| Méthode | Comportement | Quand l'utiliser |
|---|---|---|
| `Schema.parse(data)` | Retourne `T` ou **lève** une `ZodError` | Entrées utilisateur / MCP — on veut que l'erreur remonte au client MCP comme JSON-RPC error |
| `Schema.safeParse(data)` | Retourne `{ success: true, data: T }` ou `{ success: false, error: ZodError }` | Validation défensive dans un pipeline (LLM output, source externe) où on veut décider quoi faire en cas d'erreur sans lever |

**Règle** : dans les handlers MCP on utilise `.parse()` (l'erreur Zod devient une erreur JSON-RPC structurée). Dans les parsers LLM et sur les sources externes, on utilise `.safeParse()` pour pouvoir retomber sur une valeur par défaut ou réessayer.

---

## Lire une `ZodError`

Une `ZodError` contient un champ `issues: ZodIssue[]`. Chaque issue a :

| Champ | Exemple | Signification |
|---|---|---|
| `path` | `['certitude']` ou `['properties', 2, 'phase']` | Chemin dans l'objet vers le champ invalide |
| `message` | `"Number must be less than or equal to 1"` | Message humain de la règle violée |
| `code` | `"too_big"`, `"invalid_type"`, `"unrecognized_keys"`, … | Code machine |

```typescript
try {
  EstimateEvolutionInputSchema.parse(args);
} catch (err) {
  if (err instanceof z.ZodError) {
    for (const issue of err.issues) {
      console.error(`[${issue.path.join('.')}] ${issue.message}`);
    }
  }
  throw err;
}
```

Côté client MCP, l'erreur arrive dans `error.data.issues` — voir [troubleshooting.md](troubleshooting.md#zoderror-invalid-input).

---

## Écrire un schéma Zod

```typescript
import { z } from 'zod';

export const MonOutilInputSchema = z.object({
  // Champ obligatoire
  name: z.string().min(1).describe('Nom du composant'),

  // Champ optionnel avec contrainte
  certitude: z.number().min(0).max(1).optional().describe('Degré de compréhension [0-1]'),

  // Enum avec valeur par défaut
  mode: z.enum(['fast', 'thorough']).default('fast'),

  // Objet imbriqué
  metadata: z.object({
    source: z.string(),
  }).optional(),
}).strict();  // Refuse les propriétés inconnues

export type MonOutilInput = z.infer<typeof MonOutilInputSchema>;
```

**Conseils** :

- `.describe(...)` alimente le champ `description` du JSON Schema généré — **écrire pour un utilisateur MCP** (c'est ce qu'il verra dans l'autocomplétion).
- `.strict()` refuse les propriétés inconnues — évite les typos silencieuses côté client.
- Pour publier au client MCP : `z.toJSONSchema(Schema, { io: 'input' })`. L'option `io: 'input'` est **importante** : sans elle, les champs avec `.default(...)` sont marqués `required` dans le JSON Schema (car en sortie ils seront toujours présents).

---

## Règle projet — pas de `any` implicite

Tout `any` ou `unknown` doit être **justifié** par un commentaire adjacent. Le code est en `tsconfig.json` → `"strict": true` + `"noImplicitAny": true`. Par défaut, **tout doit être typé**. Quand un cast s'impose (frontière externe, sortie LLM parsée), ajouter un commentaire :

```typescript
const raw = await opencodeApi.call(prompt);  // any: sortie non validée de l'API tierce
const validated = SomeOutputSchema.parse(raw);  // typé à partir d'ici
```

Zod est le mécanisme privilégié pour passer de `unknown` à un type nommé sans `as` non vérifié.

---

## Liens

- [extending.md](extending.md#ajouter-un-nouvel-outil-mcp) — ajouter un tool MCP complet (flow Zod en 4 étapes)
- [tools-reference.md](tools-reference.md) — les schémas Zod des 4 tools MCP
- [architecture.md](architecture.md#typescript-strict--zod) — vue d'ensemble TS + Zod
- [troubleshooting.md](troubleshooting.md#zoderror-invalid-input) — lire une `ZodError` côté client
- [Zod 4 docs](https://zod.dev/) — référence officielle
