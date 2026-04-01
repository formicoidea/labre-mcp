# Strategies d'evaluation

WardleyAssistant utilise 6 strategies pluggables pour estimer la position d'evolution d'un composant. Chaque strategie produit un resultat independant : `{ evolution, confidence, method }`.

## Auto-decouverte

Les strategies sont decouvertes automatiquement au demarrage via `strategies/registry.mjs`. Tout fichier `*-strategy.mjs` dans le dossier `src/strategies/` est charge et enregistre. Aucune modification du registre n'est necessaire pour ajouter une strategie.

## Interface commune

Chaque strategie etend `BaseStrategy` (`strategies/base-strategy.mjs`) :

```javascript
class MaStrategy extends BaseStrategy {
  static get method() { return 'ma-strategy'; }
  async evaluate(component) {
    return { evolution: 0.75, confidence: 0.85, method: 'ma-strategy' };
  }
}
```

### EvolutionResult

| Champ | Type | Description |
|---|---|---|
| `evolution` | number | Position sur l'axe [0-1] (competitif) ou hors bande (extra-competitif) |
| `confidence` | number [0-1] | Score de confiance |
| `method` | string | Identifiant de la strategie |
| `trace` | array (opt.) | Etapes de raisonnement |

### ComponentInput

| Champ | Type | Description |
|---|---|---|
| `name` | string | Nom du composant |
| `certitude` | number [0-1] | Degre de comprehension |
| `ubiquity` | number [0-1] | Degre de diffusion |
| `wonder` / `build` / `operate` / `usage` | number [0-1] | Proportions de publications |
| `description` | string | Description libre |
| `date` | string/Date | Date de contexte (optionnel) |

---

## 1. S-Curve (`s-curve`)

**Principe** : Projette le couple (certitude, ubiquite) sur le modele dual sigmoide pour obtenir une evolution deterministe.

**Entrees requises** : `certitude`, `ubiquity`

**Modele mathematique** :

Le modele definit deux frontieres (sigmoide generalisee) :

```
f(c) = yMin + (yMax - yMin) * sigmoid(c, k, x0)^nu
```

Parametres par defaut :

| Frontiere | k | x0 | yMin | yMax | nu |
|---|---|---|---|---|---|
| Haute | 8.5 | 0.28 | 0 | 1 | 2.1 |
| Basse | 7 | 0.54 | 0 | 0.98 | 1.7 |

- **Dans la bande** : marche competitif (evolution [0, 1])
- **Hors bande** : extra-competitif (social_good ou common_good)

La confiance depend de la distance a la frontiere : a l'interieur = 0.7-1.0, a l'exterieur = 0.2-0.5.

**Cas d'usage** : Quand les valeurs de certitude et ubiquite sont connues avec precision.

**Fichiers** : `strategies/s-curve-strategy.mjs`, `s-curve.mjs`

---

## 2. Publication Analysis (`publication-analysis`)

**Principe** : Analyse la distribution des types de publications (wonder/build/operate/usage) pour deduire le stade d'evolution via un centroide pondere.

**Entrees requises** : `wonder`, `build`, `operate`, `usage`

**Centroides de phase** :

| Type | Centroide | Phase |
|---|---|---|
| wonder | 0.09 | Genesis |
| build | 0.22 | Custom-Built |
| operate | 0.48 | Product |
| usage | 0.85 | Commodity |

**Calcul** : `evolution = sum(proportion_i * centroide_i)` apres normalisation.

**Confiance** : Calculee via l'indice de Herfindahl-Hirschman (HHI) — une concentration elevee donne une confiance elevee.

**Fallback** : Si les proportions ne sont pas fournies, appel LLM pour les estimer.

**Fichier** : `strategies/publication-analysis-strategy.mjs`

---

## 3. Timeline Benchmark (`timeline-benchmark`)

**Principe** : Construit une timeline historique du composant via des appels LLM iteratifs, puis positionne le composant par rapport aux jalons temporels.

**Entrees requises** : `name`, `description` ou `context`

**Processus** :
1. Identification de la capacite sous-jacente via `identify-capability.mjs` (ex: "CRM" → "gestion de la relation client")
2. Construction recursive de la timeline (max 15 iterations) via LLM
3. Chaque jalon evalue par `LLMDirectStrategy` avec contexte temporel
4. Position finale basee sur l'ancrage historique

**Cas d'usage** : Composants avec une histoire connue (technologies, pratiques industrielles).

**Fichier** : `strategies/timeline-benchmark-strategy.mjs`

---

## 4. LLM Direct (`llm-direct`)

**Principe** : Demande directement au LLM d'estimer l'evolution, la certitude et l'ubiquite du composant.

**Entrees requises** : `name`, `description` ou `context`

**Important** : Le resultat final est un **blend** de 70% s-curve + 30% estimation LLM directe. Ce n'est pas une estimation LLM pure.

**Confiance** : Basee sur l'accord entre l'estimation s-curve et l'estimation LLM directe.

**Cas d'usage** : Quand aucune donnee numerique n'est disponible.

**Fichier** : `strategies/llm-direct-strategy.mjs`

---

## 5. Logprob Distribution (`logprob-distribution`)

**Principe** : Utilise les log-probabilites des tokens du LLM pour analyser la distribution de probabilite sur les 4 stades d'evolution.

**Entrees requises** : `name`, `description` ou `context`

**Backend** : OpenCode API (kimi-k2.5) uniquement — necessite `OPENCODE_API_KEY`.

**Processus** :
1. Le LLM classifie le composant parmi Genesis/Custom/Product/Commodity
2. Extraction des logprobs pour chaque token de phase
3. Conversion softmax → probabilites
4. Centroide pondere sur les midpoints de phase

**Confiance** : Basee sur l'entropie de la distribution — basse entropie = haute confiance.

**Cas d'usage** : Quand on souhaite une mesure d'incertitude basee sur les probabilites du modele.

**Fichier** : `strategies/logprob-distribution-strategy.mjs`

---

## 6. Sector Agent (`sector-agent`)

**Principe** : Agent specialise par secteur industriel qui analyse le composant dans son contexte sectoriel specifique.

**Entrees requises** : `name`, `context`

**Processus** :
1. Identification du secteur industriel
2. Comptage des fournisseurs concurrents
3. Evaluation de la standardisation et du cycle d'adoption
4. Cross-validation avec le modele s-curve

**Cas d'usage** : Composants fortement lies a un secteur specifique.

**Fichier** : `strategies/sector-agent-strategy.mjs`

---

## Tableau comparatif

| Strategie | Entrees | Backend LLM | Deterministe | Confiance | Complexite |
|---|---|---|---|---|---|
| s-curve | certitude + ubiquity | Non | Oui | Distance bande | Basse |
| publication-analysis | wonder/build/operate/usage | Optionnel | Oui | HHI | Basse |
| timeline-benchmark | name + context | Oui | Non | Richesse timeline | Haute |
| llm-direct | name + context | Oui | Non | Accord s-curve/LLM | Moyenne |
| logprob-distribution | name + context | Oui (OpenCode) | Non | Entropie distribution | Moyenne |
| sector-agent | name + context | Oui | Non | Cross-validation | Haute |

## Orchestration

Quand `strategy: "all"`, l'evaluation se fait en deux phases :

1. **Phase A** : Toutes les strategies sauf s-curve s'executent
2. **Phase B** : Les certitude/ubiquity moyennes des resultats Phase A enrichissent le composant
3. **Phase C** : S-curve s'execute avec les donnees enrichies

Le consensus final est la moyenne ponderee de toutes les strategies.
