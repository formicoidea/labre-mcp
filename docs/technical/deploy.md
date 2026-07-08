# Déploiement (seenode)

Le daemon HTTP se déploie sur [seenode](https://seenode.com) via le **lien Git natif** : chaque application seenode est liée au repo GitHub et redéploie automatiquement à chaque push sur sa branche. Aucun pipeline GitHub Actions n'est requis.

## Modèle de branches et instances

Deux instances, calées sur le modèle de branches du repo (identique au repo labre) :

| Instance | Branche suivie | Rôle |
|---|---|---|
| **prod** | `master` | Production. Se met à jour au merge `staging` → `master`. |
| **staging** | `staging` | Pré-production. Se met à jour au merge de chaque PR (toutes les PR ciblent `staging`, branche par défaut du repo). |

`master` est protégée (PR obligatoire, pas de push direct, force-push bloqué). La mise en production est donc toujours : PR → `staging` → PR `staging` → `master`.

## Configuration d'une application seenode

| Champ | Valeur |
|---|---|
| Repository | `formicoidea/labre-mcp` |
| Branch | `master` (prod) ou `staging` (staging) |
| Root directory | vide ou `/` (le package.json est à la racine) |
| Build command | `pnpm install --frozen-lockfile && pnpm run build` |
| Start command | `npm run mcp:prod` |
| Port | `6767` (doit correspondre à `LABRE_HTTP_PORT`, défaut `6767`) |
| Node | ≥ 20 (champ `engines` du package.json) |

> **Pourquoi pnpm ?** Le repo est en pnpm (`pnpm-lock.yaml`, pas de `package-lock.json`) : `npm ci` échoue. pnpm est préinstallé dans l'image seenode — ne pas faire `npm install -g pnpm` (EEXIST). Le start reste en `npm run` : c'est un simple `node dist/...`, pnpm est inutile au runtime.

## Variables d'environnement

⚠️ **Ordre impératif : activer l'auth AVANT de poser les clés LLM.** Sans `LABRE_AUTH`, le daemon est en auth noop (mode dev) — public, n'importe qui peut appeler `POST /mcp` et consommer les crédits des clés posées.

| Variable | Valeur | Note |
|---|---|---|
| `LABRE_HTTP_HOST` | `0.0.0.0` | **Obligatoire** — sans elle le daemon binde le loopback et le routeur seenode ne l'atteint pas (bad gateway). |
| `LABRE_HTTP_PORT` | `6767` | Doit correspondre au champ « Port » de l'app seenode. Optionnel si les deux valent 6767. |
| `LABRE_AUTH` | `supabase` | Active la vérification JWT. Fail-closed : requête sans JWT valide = rejetée. |
| `SUPABASE_URL` | `https://<projet>.supabase.co` | Vérification par JWKS (clés *publiques* du projet) — aucun secret Supabase n'est nécessaire pour l'auth, le daemon ne détient jamais de service-role key. |
| `SUPABASE_JWT_AUD` | `authenticated` | Optionnel (défaut `authenticated`). |
| `SUPABASE_ANON_KEY` | clé anon (publique) | Optionnel — uniquement pour les strategy bundles distants. |
| `WARDLEY_LLM_CONFIG` | chemin du profil prod | `llm.config.json` est gitignoré donc absent du clone ; sans ce fichier les stratégies LLM sont dégradées. Voir [configuration.md](configuration.md). |
| `OPENCODE_API_KEY` | `sk-...` | Stratégies routées vers le provider OpenCode (`logprob-distribution` par défaut). |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Provider `agent-sdk` + web search sur un serveur headless. |
| `POSTHOG_API_KEY` / `POSTHOG_HOST` | — | Optionnel : flags + télémétrie. Sans elle, flags fail open, pas de télémétrie. |
| `BIGQUERY_PROJECT_ID` / `GOOGLE_APPLICATION_CREDENTIALS` | — | Optionnel : uniquement pour la stratégie `cpc-evolution`. |

Les dépendances manquantes ne bloquent pas le boot : le framework [Degradable](degradation.md) les marque dégradées et le health check au boot les liste sur stderr.

## Vérification post-déploiement

1. Logs de boot : `[labre-mcp] HTTP server listening on http://0.0.0.0:6767 (POST /mcp)` — si `127.0.0.1`, `LABRE_HTTP_HOST` manque.
2. `GET https://<app>.seenode.app/health` → `{"status":"ok"}`.
3. `GET https://<app>.seenode.app/version`.
4. Pointer un client MCP sur `https://<app>.seenode.app/mcp` (`"type": "http"`) avec un JWT Supabase en bearer.

## Dépannage

| Symptôme | Cause | Fix |
|---|---|---|
| Build : `npm ci` → EUSAGE | Pas de `package-lock.json` (repo pnpm) | Build command pnpm ci-dessus |
| Build : `npm install -g pnpm` → EEXIST | pnpm déjà dans l'image | Retirer l'install globale |
| `/health` → bad gateway | Bind loopback ou port incohérent | `LABRE_HTTP_HOST=0.0.0.0` ; champ Port = `LABRE_HTTP_PORT` |
| Health check boot : `llm: Cannot read LLM config ... ENOENT` | `llm.config.json` gitignoré | `WARDLEY_LLM_CONFIG` vers un profil commité |

## Alternative : déclenchement par pipeline

Si un jour le déploiement doit être conditionné (tests verts, tag), seenode expose une API : `POST https://api.seenode.com/v1/applications/<id>/deployments` avec un Bearer token — voir [la doc seenode GitHub Actions](https://seenode.com/docs/guides/deployments/deployment-using-github-actions). Non utilisé aujourd'hui : le lien Git natif suffit.
