# MEGA Server

Serveur de signaux forex issus de MegaExplorer (16 combos backtestés sur 3 ans, réduits à 12 pour respecter le quota Twelve Data — voir DEPLOIEMENT.md).

## Fichiers
- `combos.js` — Configuration des 12 combos (paire, direction, timeframe, signaux requis)
- `indicators.js` — Indicateurs techniques, portés fidèlement du backtest Python (validés sur 5+ jeux de données)
- `signal_engine.js` — Moteur de matching des combos + calcul SL/TP
- `twelvedata.js` — Récupération des cotations
- `firebase.js` — Logging des signaux (path `/mega.json`, cohérent avec `/prod.json` etc.)
- `server.js` — Serveur principal, boucle de scan toutes les 15 min, 8h-22h UTC

## Avertissement important — smc_swing
Le signal `smc_swing_low/high`, utilisé dans TOUS les 12 combos, nécessite
un délai de confirmation de 5 bougies (fidèle à la définition du backtest,
qui regarde 5 bougies avant ET après). Ce n'est pas une dégradation —
c'est la traduction exacte de ce que le backtest mesurait déjà.

## Variables d'environnement (à définir sur Render)
- `TWELVE_DATA_API_KEY` = d3fa411da64b4e21b9c4314272a7df73
- `FIREBASE_URL` = https://forex-trading-bendo-default-rtdb.firebaseio.com
- `PORT` (fourni automatiquement par Render)
