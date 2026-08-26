# Banc d'essai de placement — CH-27

> **Le banc instruit C2, il ne le décide pas.**
> Il produit des chiffres et des traces. Ce qu'on en conclut — garder le moteur,
> le remplacer par une skill, ou ne rien changer — est un arbitrage humain, pas
> une sortie de programme. Aucun taux affiché ici n'est un verdict.

État livré : **À SEC**. Aucune campagne n'a été lancée, aucun jeton dépensé.
Ce qui est vérifié, c'est la mécanique (`pnpm bench:test`, 16 assertions, hors
ligne). Le pilote réel attend une décision.

---

## 1. La question

L'audit de phase 2 a posé un test de falsification, référencé **C2** :

> Une skill Markdown — la méthode écrite en prose, plus éventuellement un petit
> outil déterministe — atteint-elle le **même taux de placement correct**, avec
> la **même traçabilité**, que la stratégie de placement du moteur ?

Si oui, une grande partie de la machinerie (registre, stratégies, contrat
`signals/reasoning/insights`, prompts appariés) coûte plus qu'elle ne rapporte
sur ce chemin-là. Si non, on sait enfin *par quoi* elle le rapporte.

Le banc n'existe que pour rendre cette question **mesurable**. Il ne la tranche
pas.

---

## 2. Les quatre postures

Une seule variable change d'un bras au suivant. C'est ce qui rend l'écart entre
deux lignes lisible.

| Id | Posture | Outillage | Appels LLM / cas | Ce que le bras prouve |
| --- | --- | --- | --- | --- |
| **A** | Moteur — stratégie du registre (`llm-direct`) | registre + stratégie livrée + prompts appariés + contrat ARCH-22 | 1 | La ligne de base : ce que fait le code qu'on a payé. |
| **B** | Skill Markdown nue | `skill/place-component.skill.md` en prompt système. Rien d'autre. | 1 | Ce que la **méthode écrite** obtient à elle seule. L'écart A−B, c'est ce que le moteur ajoute au-delà de la prose. |
| **C** | Skill Markdown + CLI géométrique | B, plus la sortie de `geometry/chain-geometry.mts` injectée dans le prompt, plus un addendum qui dit au modèle quoi en faire | 1 | Si un **petit outil déterministe** suffit à rattraper l'écart. L'écart C−B isole exactement l'outil. |
| **Z** | Témoin — prior géométrique seul | aucun modèle | **0** | Le plancher. Un taux qui ne bat pas Z n'a pas été produit par la connaissance du composant, mais par la forme de la carte et le taux de base du corpus. |

Deux garde-fous d'équité, sans lesquels le banc mesurerait autre chose que ce
qu'il annonce :

- **Un seul LLM.** L'appel est injecté dans les trois bras (posture A passe par
  la couture `new LLMDirectStrategy({ llmCall })`). Même fournisseur, même
  modèle, même température. Sinon on comparerait des fournisseurs.
- **Une seule entrée.** B et C lisent le cas à travers le gabarit utilisateur du
  moteur lui-même (`postures/answer-format.mts`), et le parsing de la réponse est
  factorisé. Une différence de lecture entre deux bras serait un écart de score
  sans rapport avec les bras.

Le challenger n'est pas handicapé : la skill est délibérément **plus riche** que
le prompt système du moteur. Une falsification qui affaiblit l'adversaire ne
prouve rien.

**Z n'est pas un quatrième candidat.** C'est un témoin. Il ne coûte rien, il
n'entre jamais dans le budget d'appels, et il ne fait pas partie des trois bras
du test.

---

## 3. Ce que le banc mesure

### 3.1 Métriques

Le jeu étalon (`gold/gold-set.json`, 15 cas) porte la vérité de placement.

| Métrique | Définition |
| --- | --- |
| **Placement correct** | `|prédit − vérité| ≤ 0.1` (la `tolerance` du jeu étalon). C'est la métrique principale. |
| **Stage correct** | Le stade Wardley prédit égale le stade de référence. Plus indulgent, plus lisible. |
| **MAE / médiane** | Erreur absolue moyenne et médiane sur les cas répondus. Un bras peut avoir un bon taux et une queue affreuse. |
| **Par carte source** | Le même taux, éclaté par carte. La référence n'est **pas** également fiable sur les trois (§ 5). |
| **Appels** | Le compte *observé*, tenu par l'enregistreur du harnais — pas le compte déclaré par la posture. Une posture ne peut pas sous-déclarer ce qu'elle a envoyé. |

### 3.2 Traçabilité

C'est la **seconde moitié** du test C2, et elle est notée mécaniquement à partir
de ce que le run a réellement produit — jamais de ce qu'une posture prétend
d'elle-même. Quatre critères, chacun oui/non sur **tous** les cas répondus :

| Critère | Passe quand… |
| --- | --- |
| `structuredRationale` | la réponse porte un « pourquoi » lisible par une machine, pas seulement de la prose |
| `replayableInputs` | chaque entrée LLM est enregistrée verbatim (système + utilisateur + réponse), donc l'appel est rejouable |
| `deterministicPart` | une partie de la réponse est recalculable hors ligne, à partir du seul jeu étalon |
| `attributed` | chaque affirmation nomme son producteur (methodId, `reasoning[].by`, ou l'outil) |

Verdict : **4/4 = `oui`**, 2–3 = `partiel`, 0–1 = `non`. Une posture qui n'a
répondu à aucun cas ne récolte rien.

C'est là que le banc peut trancher sans ambiguïté même si les taux de placement
se ressemblent : deux bras à égalité de score, mais l'un rejouable et l'autre
non, ce ne sont pas deux bras à égalité.

---

## 4. Lancer

### 4.1 Le test sur stubs — gratuit, hors ligne, c'est ce qui est livré

```sh
pnpm bench:test
```

Aucun réseau, aucun jeton. Il vérifie que les quatre postures tournent de bout en
bout, que le verdict est calculé contre le jeu étalon (tolérance comprise), que
l'artefact de run s'écrit et se relit verbatim, et que le témoin Z se comporte en
témoin (zéro appel, insensible à ce que le modèle raconte). Il n'affirme **aucun
taux** : le LLM y est un stub scripté, donc tout taux y est une propriété du
script.

### 4.2 Le pilote

```sh
pnpm bench:pilot                      # PLAN SEUL — n'appelle rien, ne dépense rien
pnpm bench:pilot --dry-run            # run complet sur stub hors ligne, 0 €
pnpm bench:pilot --confirm            # LE PILOTE RÉEL
```

(La forme `pnpm bench:pilot -- --dry-run` marche aussi : pnpm 10 transmet le `--`
verbatim, et le parseur l'ignore.)

Options : `--cases <n>` (défaut 10, préfixe du jeu étalon de 15),
`--max-calls <n>` (plafond dur, défaut 30), `--concurrency <n>` (défaut 3),
`--allow-claude-provider`.

**Le coût est annoncé avant tout appel.** Sans `--confirm` ni `--dry-run`, le
pilote imprime son plan et s'arrête :

```
── plan du pilote CH-27 ───────────────────────────────────────────
  cas          : 10 (préfixe du jeu étalon de 15)
  postures     : A(1 appel/cas) B(1 appel/cas) C(1 appel/cas) Z(0 appel/cas)
  appels LLM   : 30 prévus, plafond 30
  route LLM    : opencode/kimi-k2.5 (http-api)
  mode         : PLAN SEUL
───────────────────────────────────────────────────────────────────
Rien n'a été dépensé. Relancer avec --dry-run (hors ligne) ou --confirm (réel).
```

Trois garde-fous, dans cet ordre :

1. **Le plan d'abord.** Le compte d'appels prévu et la route résolue sont
   imprimés *avant* le premier appel. `--confirm` est un geste humain explicite.
2. **Le plafond.** `runBench` refuse de démarrer si le nombre d'appels prévus
   dépasse `--max-calls`. Il refuse — il ne tronque pas.
3. **L'abonnement Claude.** Si la route résout vers un fournisseur `agent-sdk`
   (le SDK Claude Agent consomme l'abonnement Claude de l'humain), le pilote
   refuse de partir sans `--allow-claude-provider`. Ce n'est jamais le défaut
   d'un banc.

### 4.3 Le fournisseur

Le pilote route par l'identifiant de stratégie **`bench-placement`** dans
`llm.config.json` (par machine, git-ignoré ; voir `llm.config.example.json`, qui
porte désormais l'entrée) :

```json
"bench-placement": { "provider": "opencode", "model": "kimi-k2.5", "temperature": 0 }
```

Pointer les trois bras sur une entrée unique est **exactement** ce qui les épingle
à un fournisseur, un modèle et une température. Sans `llm.config.json`, le plan
s'imprime quand même mais la route est signalée `NON RÉSOLUE`, et `--confirm`
échoue avant tout appel.

La clé du fournisseur est lue depuis `.env` à la racine, au démarrage du pilote
uniquement (jamais pendant un appel d'outil — règle 20 d'AGENT.md).

---

## 5. Lire les résultats

Le pilote imprime un tableau et écrit un artefact JSON dans `bench/runs/<runId>.json`
(git-ignoré : un run est une pièce à conviction, pas une source suivie ; on
l'attache à la main à une PR ou à un ADR quand c'est lui qu'on discute).

L'artefact porte **tout** : chaque cas, la réponse, la trace verbatim de chaque
appel, la vérité, l'erreur, les scores, et la note de traçabilité critère par
critère. Il se relit avec `readRunArtifact()`.

Comment lire, dans l'ordre :

1. **Z d'abord.** C'est le plancher. Tant qu'on ne l'a pas regardé, aucun autre
   chiffre n'a de sens.
2. **A − B.** Ce que le moteur ajoute à la méthode écrite. C'est le cœur de C2.
3. **C − B.** Ce que le petit outil déterministe ajoute, tout seul.
4. **La colonne traçabilité.** Deux bras peuvent être à égalité de placement et
   très loin l'un de l'autre ici.
5. **Le détail par carte.** Voir ci-dessous.

### Ce que la référence est, et n'est pas

Le jeu étalon est dérivé de **trois cartes écrites à la main**
(`maps/myMaps/`). Les coordonnées d'évolution y ont été choisies délibérément par
une personne. C'est donc **le placement d'un annotateur**, pas une mesure
objective. Une posture qui contredit la référence peut avoir tort — ou avoir
raison contre une position discutable.

- `tea-shop` est l'exemple canonique d'enseignement Wardley : confiance la plus
  haute ;
- `spotify` et `s2e` sont des cartes de travail de l'auteur du dépôt : à lire
  avec la marge que ça impose.

C'est précisément pour ça que le harnais publie un détail par carte, et pourquoi
un écart global de quelques points n'autorise à conclure à rien tout seul.

**N=15.** Le jeu étalon tient 15 cas, le pilote en tourne 10 par défaut. À cette
taille, un écart de deux ou trois cas est du bruit. Le banc est fait pour
montrer un **effet franc**, pas pour départager deux bras à trois points.

### Pourquoi pas `dataset/records.jsonl`

Le jeu de données synthétique (`scripts/build-dataset.mts`) ne porte **aucune**
vérité de placement : ses cartes sortent d'un PRNG à graine, donc chaque scalaire
d'évolution est un tirage uniforme sans sens sémantique. C'est un oracle
d'aller-retour pour les stratégies de rendu, pas une référence de placement.
Mesurer le placement contre lui, ce serait noter du bruit.

---

## 6. Reconstruire le jeu étalon

```sh
pnpm bench:gold
```

Sélection **stratifiée et déterministe** : on cycle sur les quatre stades en
prenant un candidat par stade et par tour, en alternant les trois cartes. Pas
d'échantillonnage, pas d'aléa — les mêmes trois cartes donnent toujours le même
jeu, et le préfixe que tourne le pilote est équilibré par construction.

`gold/gold-set.json` est **commité** : le banc doit être rejouable sans
re-dériver la référence, et un changement de référence doit apparaître comme un
diff relisible.

### L'invariant de fuite

La vue de carte que voient les postures (`GoldMap`) **n'a pas de champ
`evolution`** — absent, pas masqué. La réponse n'est donc lisible ni par une
posture, ni par un raccourci qu'un futur contributeur ajouterait : il n'y a rien
à lire. La visibilité (l'autre axe, la chaîne de valeur) survit parce qu'elle est
autorée indépendamment de l'axe mesuré. `bench.test.mts` épingle l'invariant en
sérialisant `maps` et en refusant que la chaîne `evolution` y apparaisse.

Le CLI géométrique se lance aussi à la main :

```sh
pnpm exec tsx --conditions labre-mcp-dev bench/geometry/chain-geometry.mts \
  --map tea-shop --component brewing-equipment
```

Son prior est une **heuristique monotone grossière** (« profond dans la chaîne »
→ « plus loin sur l'évolution »). Ce n'est pas une affirmation de théorie
Wardley : les deux axes sont indépendants par construction. C'est l'outil du
challenger, et savoir s'il mérite sa place est exactement ce que le banc mesure.

---

## 7. Périmètre et frontières

**Mode bibliothèque uniquement.** Le banc n'importe **rien** de `src/core/transport/`
ni de `src/mcp/` : pas de démon, pas de HTTP, pas d'enveloppe MCP. Il consomme le
moteur par ses coutures publiées (`#core/*`, `#frameworks/*`, `#lib/*`,
`#types/*`) et l'appelle en processus. Ce qu'il mesure est donc la **stratégie**,
pas le transport — et une régression de transport ne peut pas se déguiser en
régression de placement.

**Le banc n'écrit jamais dans `src/`.** Il consomme, il ne rustine pas. Patcher
le titulaire pour rendre le banc plus joli, ce serait exactement ce qui invalide
un test de falsification.

Le garde `pnpm check:boundaries` ne couvre pas `bench/` (son périmètre est
`src/core`) ; la règle ci-dessus tient par revue, et le grep est trivial :

```sh
grep -rn "#mcp/\|#core/transport" bench/ --include='*.mts'    # doit ne rien rendre
```

---

## 8. Limites connues

- **Reproductibilité.** Tout ce que le harnais possède est déterministe (ids,
  dates, latences, scores, traces) grâce à l'horloge injectée. **Une exception,
  mesurée et non supposée** : les `signals[].capturedAt` de la posture A sont
  horodatés par `BaseStrategy` sur l'horloge système, à l'intérieur de la
  stratégie testée. Le harnais ne va pas la remplacer de force. `bench.test.mts`
  neutralise ce seul champ avant de comparer deux runs, et le dit.
- **Un annotateur, trois cartes, 15 cas.** Voir § 5.
- **Un seul appel par cas.** Les bras sont comparés à coût égal. Une posture
  multi-tours (auto-critique, vote) n'est pas dans le banc — ce serait une
  cinquième posture, et un autre budget.
- **Les ancres sont hors périmètre.** Le moteur les place avec une autre
  stratégie (`position-anchor-in-evolution`) ; le jeu étalon ne retient que les
  composants.

---

## 9. Carte des fichiers

```
bench/
├── README.md                      ce document
├── bench.types.mts                le vocabulaire partagé (aucune logique, aucune E/S)
├── bench.test.mts                 le banc de bout en bout sur stubs — hors ligne
├── harness.mts                    exécution, scoring, traçabilité, artefact
├── run-pilot.mts                  LE SEUL point d'entrée qui peut dépenser
├── gold/
│   ├── build-gold-set.mts         dérive la référence des trois cartes
│   └── gold-set.json              la référence, COMMITÉE
├── geometry/
│   └── chain-geometry.mts         le CLI déterministe (posture C, témoin Z)
├── postures/
│   ├── answer-format.mts          contrat de réponse partagé (parité d'entrée/lecture)
│   ├── posture-a-engine.mts       A — le moteur
│   ├── posture-b-skill.mts        B — la skill nue
│   ├── posture-c-skill-cli.mts    C — la skill + le CLI
│   └── posture-z-control.mts      Z — le témoin
├── skill/
│   ├── place-component.skill.md   la méthode en prose (B et C)
│   └── geometry-tool.addendum.md  l'unique différence entre B et C
└── runs/                          artefacts de campagne (git-ignoré)
```
