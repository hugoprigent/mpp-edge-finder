# MPP Edge Finder

Assistant de décision pour Mon Petit Prono: il combine les points MPP, la foule MPP et les probabilités publiques Polymarket pour proposer l'issue et le score exact avec le meilleur objectif selon la stratégie active.

Le projet ne place aucun prono automatiquement. Il affiche et notifie les recommandations pour validation manuelle dans MPP.

## Démarrage local

```bash
npm install
npm run browsers:install
npm run dev
```

Dans un autre terminal, pour l'interface Vite en dev:

```bash
npm run dev:client
```

En production ou après build:

```bash
npm run build
npm start
```

Interface: `http://localhost:8787`

Le dashboard est protégé par un PIN côté API. Par défaut en local/VPS:

```bash
DASHBOARD_PIN_CODES=1706,0000
```

Le tableau principal donne les recos jouables triées par score stratégie, avec une colonne `À jouer` qui dit quoi saisir précisément dans MPP (`Mets 0-2 pour Pays-Bas`, `Mets 1-1 (nul)`, etc.). Le bouton `Voir` ouvre le détail du match: EV par issue, points et foule MPP, leverage de classement, marchés Polymarket, raisons et historique récent des probabilités.

## Stratégie

Par défaut, l'app tourne en `MPP_STRATEGY_MODE=chase`, adapté quand tu es loin au classement et que tu veux maximiser les chances de remonter:

- l'EV réelle reste affichée et calculée comme probabilité Polymarket x points MPP + EV du bonus score exact;
- le score stratégie ajoute une prime de leverage aux issues peu jouées par la foule MPP;
- une issue est pénalisée si elle est très populaire côté MPP mais moins soutenue par Polymarket;
- les très faibles probabilités gardent une pénalité de loterie pour éviter les coups trop gratuits;
- le score exact optimise le bonus exact attendu, avec une prime légère aux scores rares en mode chase.

Pour revenir à une logique strictement prudente:

```bash
MPP_STRATEGY_MODE=ev
```

Les poids du mode chase sont réglables dans `.env`: `MPP_CHASE_LEVERAGE_WEIGHT`, `MPP_CHASE_POSITIVE_CROWD_EDGE_WEIGHT`, `MPP_CHASE_NEGATIVE_CROWD_EDGE_WEIGHT`, `MPP_CHASE_LOTTERY_PENALTY_WEIGHT`, `MPP_CHASE_MIN_USEFUL_PROBABILITY`, `MPP_CHASE_SCORE_BONUS_WEIGHT`.

À partir des matchs à élimination directe, l'app marque le match en `scope MPP 120 min` et réduit la confiance d'un niveau, car les marchés externes peuvent être exprimés en 90 minutes alors que MPP compte 120 minutes hors tirs au but.

## Données gratuites

- Polymarket public: aucun compte, aucune clé. Poll toutes les 5 min par défaut, puis 60 s quand un match est à moins de 2 h.
- MPP: soit import manuel via le bookmarklet, soit Playwright avec profil Chromium persistant.
- Telegram: optionnel et gratuit via BotFather. Sans Telegram, le dashboard peut afficher une alerte navigateur si l'onglet reste ouvert.

## MPP automatisé sur VPS

MPP expose des endpoints applicatifs sur `api.mpp.football`, mais les listes utiles testées (`/championships-current-matches/by-date`, `/championship-clubs`, `/championships-settings/active`) renvoient `401` sans session authentifiée. En v1, on ne lit pas les cookies, le localStorage ni les jetons: on extrait uniquement ce qui est déjà visible sur ta page MPP connectée.

En production, l'objectif est que le VPS actualise MPP lui-même:

1. Tu connectes une seule fois le profil Chromium persistant sur le VPS.
2. Le conteneur app relance ensuite le scraper MPP automatiquement avec ce profil.
3. Le dashboard et les notifications affichent `À jouer: Mets X-Y...` pour chaque match exploitable.

Variables utiles:

```bash
MPP_HEADLESS=true
MPP_AUTO_SCRAPE=true
MPP_POLL_MINUTES=10
MPP_FAST_POLL_MINUTES=2
MPP_PROFILE_DIR=./data/mpp-chrome-profile
MPP_LOCAL_UTC_OFFSET_HOURS=0
```

`MPP_LOCAL_UTC_OFFSET_HOURS` doit correspondre au fuseau affiché par le navigateur Playwright. Dans le conteneur Docker du VPS, Chromium tourne en UTC, donc `0` est le bon réglage. Si tu lances le scraper dans un navigateur local qui affiche l'heure de Paris en été, mets `2`.

## Auto-saisie MPP

L'app peut saisir automatiquement le prono MPP recommandé juste avant la fermeture:

```bash
MPP_AUTO_PLAY=true
MPP_AUTO_PLAY_DRY_RUN=false
MPP_AUTO_PLAY_LEAD_SECONDS=60
MPP_AUTO_PLAY_WINDOW_SECONDS=45
```

Fonctionnement:

1. Le scheduler surveille les matchs proches du coup d'envoi.
2. Dans la fenêtre T-60s, il rafraîchit Polymarket et MPP.
3. Il recalcule la meilleure recommandation selon la stratégie active.
4. Il ouvre la session Chromium persistante MPP et remplit les deux champs du score exact.
5. Il marque le match comme traité pour éviter une double saisie.

Le bouton `Dry-run MPP` vérifie la correspondance match/inputs sans écrire. Le bouton `Jouer MPP maintenant` applique manuellement la meilleure recommandation exploitable, sans attendre T-60s.

Login initial MPP sur VPS, sans service payant:

```bash
docker compose -f docker-compose.yml -f docker-compose.vnc.yml up --build mpp-login
```

Ouvre ensuite `http://IP_DU_VPS:6080/vnc.html`, connecte-toi à MPP, attends que les matchs soient visibles, puis arrête le service `mpp-login`. Le profil est conservé dans `./data/mpp-chrome-profile`; le service principal peut ensuite scraper en headless.

La méthode DOM validée est:

1. L'app lit les textes visibles, les champs de score, les points MPP et les pourcentages de foule depuis le DOM MPP.
2. Elle envoie le snapshot localement à `POST /api/import/mpp-text`.
3. Le parser reconstitue les matchs, puis le moteur recalcule les recommandations.

Fallbacks si le VPS perd sa session MPP:

1. Import direct Chrome: dans l'interface, copie `Copier import direct`, ajoute-le en favori, ouvre MPP connecté, clique le favori. Le snapshot arrive directement dans l'app.
2. Import manuel robuste: utilise `Copier JSON`, clique-le sur MPP connecté, colle le JSON dans l'interface.
3. Scraper Playwright: `POST /api/scrape/mpp/run` ouvre `mpp.football` avec le profil `MPP_PROFILE_DIR`. Lance en `MPP_HEADLESS=false`, connecte-toi une fois, puis relance le scrape.

Le bookmarklet exact est généré par `GET /api/bookmarklet`, car l'URL d'import dépend de l'adresse locale ou VPS de l'app.

## Notifications gratuites

Dans `.env`:

```bash
# Option 1, sans compte: ntfy
NTFY_TOPIC=mpp-edge-topic-long-et-aleatoire
NTFY_SERVER_URL=https://ntfy.sh

# Option 2: Telegram
TELEGRAM_BOT_TOKEN=123:abc
TELEGRAM_CHAT_ID=123456
```

Pour générer un topic ntfy difficile à deviner:

```bash
./scripts/generate-ntfy-topic.sh
```

Installe l'app ntfy sur ton téléphone ou ouvre `https://ntfy.sh/app`, abonne-toi à ce topic, puis le VPS pourra envoyer les alertes T-10 par HTTP POST sans compte. Le topic fonctionne comme un mot de passe léger: garde-le privé.

Le worker envoie une alerte une seule fois par match autour de `T-10 min`.

Dans l'interface, le bouton `Activer alertes navigateur` permet d'avoir une notification gratuite locale à `T-10` tant que le dashboard est ouvert. Sur VPS, ntfy ou Telegram restent préférables car ils n'ont pas besoin que ton navigateur reste ouvert.

## VPS

```bash
cp .env.example .env
docker compose up -d --build
BASE_URL=http://127.0.0.1:8787 ./scripts/vps-smoke-test.sh
```

Le volume `./data` conserve la base SQLite et le profil navigateur MPP. Le conteneur expose aussi `GET /api/healthz`, utilisé par le healthcheck Docker.

Déploiement SSH générique:

```bash
VPS_HOST=IP_DU_VPS VPS_USER=root VPS_PATH=/opt/mpp-edge-finder ./scripts/deploy-vps.sh
```

Le service `mpp-login` dans `docker-compose.vnc.yml` est temporaire: utilise-le seulement quand il faut reconnecter MPP, puis coupe-le pour ne pas laisser noVNC exposé.

## Hermes Agent

Hermes peut être branché comme superviseur via les endpoints locaux:

- `GET /api/hermes/manifest`
- `GET /api/hermes/tools/get_next_recommendations`
- `GET /api/hermes/tools/get_system_health`
- `GET /api/hermes/tools/get_match_recommendation?matchId=...`
- `POST /api/hermes/tools/send_manual_briefing`

Il doit surveiller et résumer; il ne doit pas modifier les pronos MPP en v1.
