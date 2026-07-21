'use strict';
const express = require('express');
const app = express();
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const { COMBOS, PAIRS, PAIR_TIMEFRAMES } = require('./combos.js');
const { fetchCandles } = require('./twelvedata.js');
const { computeAllSignals, comboMatches, computeSlTp } = require('./signal_engine.js');
const { logSignal, getLastSignalTime, setLastSignalTime } = require('./firebase.js');

const PORT = process.env.PORT || 10000;
const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes — calibré sur le quota Twelve Data (voir analyse: ~560 req/jour sur 800, 30% de marge)
const ACTIVE_HOUR_START = 8;  // heure Paris (Europe/Paris, gère heure d'été/hiver automatiquement) de début de fenêtre active
const ACTIVE_HOUR_END = 22;   // heure Paris de fin de fenêtre active
const MIN_RESCAN_GAP_MS = 60 * 60 * 1000; // anti-duplication: pas 2 fois le même signal en moins d'1h

// ─── CLÉS TWELVE DATA (jour vs nuit) ──────────────────────────────────────────
// Chaque clé gratuite est limitée à 800 req/jour. Le scan jour (~700 req) et le
// scan nuit (~600 req) ne rentrent pas sur une seule clé. On dédie donc une clé
// par session pour rester sous le quota de chacune.
//   - Jour : la clé du scan (celle de twelvedata.js, d3fa411...)
//   - Nuit : une 3e clé dédiée
const { TWELVE_KEY: DAY_KEY } = require('./twelvedata.js');
const NIGHT_KEY = process.env.TWELVE_NIGHT_KEY || '30657c93a300488e8d7e593562f28cbc';

// ─── FENÊTRE NUIT ─────────────────────────────────────────────────────────────
// Le jour = 8h-22h (exécuté sur IG). La nuit = 22h-8h, scannée UNIQUEMENT pour
// collecter des statistiques comparatives (session:"nuit"). Les signaux de nuit
// NE SONT PAS exécutés sur IG (l'exécuteur les ignore) tant qu'on n'a pas la
// preuve que la nuit est rentable — le spread nocturne est bien plus large.
const NIGHT_HOUR_START = 22; // 22h Paris
const NIGHT_HOUR_END = 8;    // 8h Paris

// ─── FILTRE SL MINIMUM (protection contre le spread) ──────────────────────────
// Le spread est un coût FIXE en pips. Sur un SL serré il représente une part
// énorme du risque et détruit le ratio réel:
//   SL 3.6 pips + spread 0.7  -> ratio réel 1:1.09 (au lieu de 1:1.50)
//   SL 20  pips + spread 0.7  -> ratio réel 1:1.42 (quasi intact)
// Comme SL = 1.5 x ATR, un marché calme (ATR faible) produit un SL minuscule
// sur lequel la stratégie n'a mathématiquement AUCUN edge, même si le signal
// est bon.
//
// On NE MODIFIE PAS la formule SL/TP (sinon on casse la comparabilité avec le
// backtest MegaExplorer): on se contente de REJETER le signal quand le SL est
// trop serré face au spread. Les trades pris restent identiques à ceux du
// backtest, on en écarte juste une catégorie sans edge.
//
// Seuil: SL >= 10 x spread, ce qui garde le WR breakeven sous ~44%.
const SPREADS_PIPS = {
    EUR_USD: 0.6,
    GBP_USD: 0.9,
    USD_JPY: 0.7,
    USD_CHF: 1.5,
    AUD_USD: 0.7,
    USD_CAD: 1.7,
    NZD_USD: 1.0,
    EUR_GBP: 0.9,
};
const SL_SPREAD_MULTIPLE = 10;

function minSlPips(pairKey) {
    const spread = SPREADS_PIPS[pairKey];
    if (spread === undefined) return 0; // paire inconnue: pas de filtre
    return spread * SL_SPREAD_MULTIPLE;
}

function slDistancePips(pairKey, entry, sl) {
    const pipSize = pairKey.endsWith('JPY') ? 0.01 : 0.0001;
    return Math.abs(entry - sl) / pipSize;
}

let lastScanResults = { timestamp: null, signals: [] };
let scanCount = 0;
let errorCount = 0;

function isWithinActiveHours() {
    // Utilise Europe/Paris (pas un décalage UTC fixe) pour gérer
    // automatiquement le changement heure d'été/hiver — un décalage fixe
    // (ex: UTC+2) se serait décalé de 1h deux fois par an.
    const heureParis = parseInt(
        new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()),
        10
    );
    return heureParis >= ACTIVE_HOUR_START && heureParis < ACTIVE_HOUR_END;
}

// Retourne la session courante selon l'heure de Paris:
//   "jour"  entre 8h et 22h   -> scan sur clé jour, exécuté sur IG
//   "nuit"  entre 22h et 8h   -> scan sur clé nuit, stats seulement
function currentSession() {
    const heureParis = parseInt(
        new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()),
        10
    );
    return (heureParis >= ACTIVE_HOUR_START && heureParis < ACTIVE_HOUR_END) ? 'jour' : 'nuit';
}

// Le marché forex est fermé le week-end (du vendredi ~22h au dimanche ~23h
// Paris). Sans cette protection, MEGA générait des signaux le samedi/dimanche
// et pouvait même les "clôturer" sur des bougies week-end non fiables que
// Twelve Data renvoie quand même (données figées / micro-mouvements
// résiduels), d'où des trades apparus ET clôturés le week-end.
function isMarketOpen() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hour12: false
    }).formatToParts(new Date());
    const jour = parts.find(p => p.type === 'weekday').value; // Mon..Sun
    const heure = parseInt(parts.find(p => p.type === 'hour').value, 10);

    if (jour === 'Sat') return false;                    // samedi: fermé toute la journée
    if (jour === 'Sun' && heure < 23) return false;      // dimanche: fermé jusqu'à 23h (réouverture)
    if (jour === 'Fri' && heure >= 22) return false;     // vendredi: fermé à partir de 22h
    return true;
}

/*
 * Récupère les bougies pour chaque (paire, timeframe) UNIQUE nécessaire —
 * une seule requête Twelve Data par combinaison, même si plusieurs combos
 * partagent la même paire/timeframe (économie de quota déjà intégrée).
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Limiteur à fenêtre glissante: au lieu d'espacer chaque requête d'un délai
// fixe (prudent mais lent), on autorise les requêtes à partir tout de suite
// tant qu'on est sous la limite, et on ne freine que quand la fenêtre des
// 60 dernières secondes est pleine. Marge de sécurité: 7 crédits/min au lieu
// de 8 (la vraie limite Twelve Data), et fenêtre de 61s au lieu de 60s pour
// absorber la latence réseau/horloge.
const RATE_LIMIT_WINDOW_MS = 61000;
// Abaissé de 7 à 4: lors d'un redeploy Render, l'ancienne et la nouvelle
// instance tournent brièvement en parallèle, chacune avec son propre
// compteur en mémoire — deux instances à 7 crédits chacune peuvent
// additionner 14 crédits côté Twelve Data. À 4, même avec 2 instances
// simultanées on reste à 8, tout juste à la limite réelle.
const RATE_LIMIT_MAX_REQUESTS = 4;
const requestTimestamps = [];

async function waitForRateLimit() {
    const now = Date.now();
    while (requestTimestamps.length && now - requestTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
        requestTimestamps.shift();
    }
    if (requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
        const waitMs = RATE_LIMIT_WINDOW_MS - (now - requestTimestamps[0]) + 200;
        await sleep(waitMs);
        return waitForRateLimit();
    }
    requestTimestamps.push(Date.now());
}

async function fetchAllCandles(apiKey) {
    const candlesByPairTf = {};
    for (const [pair, tfs] of Object.entries(PAIR_TIMEFRAMES)) {
        candlesByPairTf[pair] = {};
        for (const tf of tfs) {
            await waitForRateLimit();
            try {
                const candles = await fetchCandles(pair, tf, 150, apiKey);
                candlesByPairTf[pair][tf] = candles;
            } catch (e) {
                console.error(`Erreur fetch ${pair} ${tf}:`, e.message);
                errorCount++;
                candlesByPairTf[pair][tf] = null;
            }
        }
    }
    return candlesByPairTf;
}

const FIREBASE_URL = process.env.FIREBASE_URL || 'https://forex-trading-bendo-default-rtdb.firebaseio.com';
// Clé dédiée à la vérification des trades (checkTrades). Distincte de la clé de
// scan jour (twelvedata.js) et de la clé nuit, pour ne pas cumuler les quotas.
// Variable propre (CHECK_TWELVE_KEY) afin d'éviter toute collision si
// TWELVE_DATA_API_KEY est définie sur Render pour le scan.
const TWELVE_DATA_API_KEY = process.env.CHECK_TWELVE_KEY || '80ddd35489f3427d8c43f29c995d6372';
// Clé DÉDIÉE au croisement M1 (validation croisée des clôtures) — séparée de
// TWELVE_DATA_API_KEY ci-dessus, qui est déjà partagée par checkTrades(),
// l'app (prix live), l'exécuteur IG (secours de taux) et le vérificateur
// externe. Le croisement M1 ajoute potentiellement 100+ requêtes par
// /recheck-all (une par clôture détectée) — sans clé séparée, ça épuiserait
// le quota partagé et gênerait checkTrades() en temps réel.
const M1_CHECK_TWELVE_KEY = process.env.M1_CHECK_TWELVE_KEY || '8dc6bc399e3b41f58626ec29e8a6b970';

async function fetchCandlesSince(pair, sinceMs, interval = '15min') {
    await waitForRateLimit();
    const start = new Date(sinceMs);
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');

    // BUG CORRIGÉ (confirmé le 21/07): outputsize=500 fixe ne couvre que
    // ~5.2 jours en M15 (500 x 15min). Pour un signal ancien, la série de
    // bougies s'arrêtait à "earliestTs + 5.2 jours" — PAS à aujourd'hui.
    // Résultat: tous les signaux plus récents que cette limite partageaient
    // le MÊME jeu de bougies tronqué, et la dernière bougie disponible
    // (un artefact de troncature, pas une vraie fin de trade) était acceptée
    // comme "clôture confirmée par elle-même" par detectClosure() — d'où
    // des dizaines de résultats collés à la même date/heure sur des paires
    // différentes (51 corrections identiques à 2026-07-16 03:45:00 lors
    // du premier /recheck-all après ce correctif).
    //
    // On calcule maintenant l'outputsize nécessaire pour couvrir TOUT
    // l'intervalle depuis sinceMs jusqu'à maintenant, avec une marge de
    // sécurité de 20%, plafonné à 5000 (max pratique par requête).
    const minutesPerCandle = interval === '15min' ? 15 : interval === '30min' ? 30 : 60;
    const spanMinutes = (Date.now() - sinceMs) / 60000;
    const needed = Math.ceil((spanMinutes / minutesPerCandle) * 1.2) + 10;
    const outputsize = Math.min(5000, Math.max(150, needed));
    if (needed > 5000) {
        console.warn(`⚠️  fetchCandlesSince ${pair}: intervalle de ${(spanMinutes/1440).toFixed(1)} jours nécessiterait ${needed} bougies, plafonné à 5000 — troncature possible pour ce signal ancien.`);
    }

    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${interval}&start_date=${encodeURIComponent(fmt(start))}&outputsize=${outputsize}&apikey=${TWELVE_DATA_API_KEY}&format=JSON&timezone=UTC`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (!d.values || d.status === 'error') throw new Error(d.message || 'Pas de donnees retournees');
    // Chronologique (ancien -> recent), on retire la derniere bougie qui peut
    // etre encore en cours de formation (high/low provisoires).
    return d.values.reverse().slice(0, -1);
}

/*
 * DÉTECTION DE CLÔTURE ROBUSTE — remplace le simple "high>=tp / low<=sl".
 *
 * BUG CORRIGÉ (confirmé le 20/07 sur un USD/JPY): une bougie Twelve Data
 * isolée et aberrante (donnée corrompue, pic de mèche, artefact de
 * réouverture de marché) pouvait déclencher un WIN/LOSS qui n'a JAMAIS eu
 * lieu en réalité — vérifié en comparant au prix réel IG, resté à des heures
 * de distance du niveau soi-disant "touché". Même schéma observé sur un
 * GBP/USD ayant traversé un week-end.
 *
 * Deux filtres indépendants et complémentaires:
 *
 *  1. PLAUSIBILITÉ — l'amplitude (high-low) de la bougie qui touche TP/SL ne
 *     doit pas dépasser un multiple de l'ATR récent (14 bougies). Une bougie
 *     anormalement large par rapport à la volatilité ambiante est traitée
 *     comme une donnée suspecte et ignorée pour la détection (on continue
 *     sur les bougies suivantes, on ne s'arrête pas dessus).
 *
 *  2. CONFIRMATION — même plausible, un simple attouchement ne suffit pas:
 *     la bougie SUIVANTE doit rester du bon côté du niveau touché (son
 *     high/low doit lui aussi dépasser le niveau, ou son close rester au-delà
 *     d'une marge). Ça élimine les "wick and revert" — un artefact isolé qui
 *     ne persiste pas dans les bougies suivantes, exactement le cas observé.
 *
 * Sans confirmation possible (dernière bougie de la série), on N'ACCEPTE PAS
 * la clôture: mieux vaut attendre le prochain scan que déclarer un résultat
 * non confirmé.
 */
function computeATR(candles, period = 14) {
    if (candles.length < 2) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = parseFloat(candles[i].high), l = parseFloat(candles[i].low);
        const pc = parseFloat(candles[i - 1].close);
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const slice = trs.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
}

const PLAUSIBILITY_MAX_ATR_MULT = 4; // bougie rejetée si (high-low) > 4x l'ATR récent

// Récupère les bougies M1 (1 minute) d'une fenêtre précise — utilisé
// UNIQUEMENT pour revalider une bougie M15 qui semble toucher TP/SL,
// avant d'accepter le résultat. Fenêtre étroite = coût API minime (1 appel
// par clôture détectée, pas par bougie scannée).
async function fetchM1Window(pair, fromMs, toMs) {
    await waitForRateLimit();
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=1min&start_date=${encodeURIComponent(fmt(new Date(fromMs)))}&end_date=${encodeURIComponent(fmt(new Date(toMs)))}&outputsize=30&apikey=${M1_CHECK_TWELVE_KEY}&format=JSON&timezone=UTC`;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        if (!d.values || d.status === 'error') return null;
        return d.values.reverse();
    } catch (e) {
        return null; // échec réseau/quota — l'appelant gère le repli (fail open)
    }
}

/*
 * VALIDATION CROISÉE M1 — remplace la logique de "confirmation par la
 * bougie suivante" (retirée : elle rejetait à tort de vrais gains/pertes
 * rapides, cf. le cas d'un aller-retour légitime qui touche le niveau puis
 * repart). Le filtre ATR restait un test STATISTIQUE (probable/improbable),
 * pas une preuve — un vrai pic de volatilité peut dépasser le seuil, une
 * donnée corrompue peut rester dessous.
 *
 * Ici, dès qu'une bougie M15 plausible touche un niveau, on va VÉRIFIER le
 * fait en interrogeant les bougies M1 de cette même fenêtre de 15 minutes,
 * chez le même fournisseur. Si le prix a VRAIMENT touché ce niveau, ce sera
 * visible minute par minute. Si la bougie M15 était une donnée corrompue
 * (agrégat erroné), le détail M1 ne le montrera pas — on continue alors la
 * recherche au lieu d'accepter.
 *
 * En cas d'échec du fetch M1 (réseau, quota) : on accepte quand même le
 * résultat M15 (repli délibéré — mieux vaut un résultat non revérifié que
 * de bloquer toute détection de clôture).
 */
async function detectClosure(pair, direction, tp, sl, postEntry) {
    for (let i = 0; i < postEntry.length; i++) {
        const c = postEntry[i];
        const high = parseFloat(c.high), low = parseFloat(c.low);

        // Pré-filtre rapide (sans appel API) : élimine les cas les plus
        // grossiers avant de dépenser une requête de validation croisée.
        const atr = computeATR(postEntry.slice(0, i + 1));
        const amplitude = high - low;
        if (atr && amplitude > atr * PLAUSIBILITY_MAX_ATR_MULT) {
            continue;
        }

        let touched = null; // 'WIN' | 'LOSS' | null
        if (direction === 'BUY') {
            if (high >= tp) touched = 'WIN';
            else if (low <= sl) touched = 'LOSS';
        } else {
            if (low <= tp) touched = 'WIN';
            else if (high >= sl) touched = 'LOSS';
        }
        if (!touched) continue;

        // Validation croisée M1 sur la fenêtre de cette bougie M15 (+ marge).
        const windowStart = new Date(c.datetime).getTime() - 60000;
        const windowEnd = windowStart + 17 * 60000;
        const m1 = await fetchM1Window(pair, windowStart, windowEnd);

        if (m1 && m1.length) {
            const confirmed = m1.some((m) => {
                const mh = parseFloat(m.high), ml = parseFloat(m.low);
                if (direction === 'BUY') {
                    return touched === 'WIN' ? mh >= tp : ml <= sl;
                } else {
                    return touched === 'WIN' ? ml <= tp : mh >= sl;
                }
            });
            if (!confirmed) {
                continue; // la bougie M15 ne résiste pas au zoom M1 — probable artefact
            }
        }
        // Pas de données M1 (échec/quota) : repli — on accepte le résultat M15.

        return { result: touched, closePrice: touched === 'WIN' ? tp : sl, closeDate: c.datetime };
    }
    return null;
}

/*
 * Relit les trades actifs (result null/absent) depuis Firebase, et verifie
 * chaque bougie M15 depuis l'ouverture, DANS L'ORDRE CHRONOLOGIQUE, pour
 * trouver quel niveau (TP ou SL) a ete touche EN PREMIER.
 *
 * Version precedente: ne verifiait que le prix "actuel" au moment du scan.
 * Ca causait des erreurs quand le prix touchait un niveau puis rebondissait
 * au-dela de l'autre avant le scan suivant.
 */
async function checkTrades() {
    // Pas de vérification le week-end: Twelve Data renvoie des bougies non
    // fiables (marché fermé), qui pouvaient déclencher de fausses clôtures.
    if (!isMarketOpen()) {
        console.log(`[${new Date().toISOString()}] Marché fermé (week-end), vérification des trades ignorée.`);
        return;
    }

    let activeSignals;
    try {
        const r = await fetch(`${FIREBASE_URL}/mega/signals.json`);
        const data = await r.json();
        activeSignals = data
            ? Object.entries(data)
                  .filter(([, s]) => s.result === null || s.result === undefined)
                  .map(([key, s]) => ({ ...s, _fbKey: key }))
            : [];
    } catch (e) {
        console.error('checkTrades: erreur lecture Firebase:', e.message);
        return;
    }

    if (!activeSignals.length) return;

    console.log(`[${new Date().toISOString()}] Verification de ${activeSignals.length} trade(s) actif(s)...`);

    const decodePair = p => p.replace('_', '/');

    const byPair = {};
    for (const s of activeSignals) {
        const pair = decodePair(s.pair);
        (byPair[pair] = byPair[pair] || []).push(s);
    }

    for (const [pair, signals] of Object.entries(byPair)) {
        const earliestTs = Math.min(...signals.map(s => new Date(s.timestamp).getTime()));
        let candles;
        try {
            candles = await fetchCandlesSince(pair, earliestTs);
        } catch (e) {
            console.error(`checkTrades: erreur bougies ${pair}:`, e.message);
            continue;
        }
        if (!candles.length) continue;

        for (const signal of signals) {
            const entryTs = new Date(signal.timestamp).getTime();
            const postEntry = candles.filter(c => new Date(c.datetime).getTime() > entryTs);
            if (!postEntry.length) continue;

            const tp = parseFloat(signal.tp);
            const sl = parseFloat(signal.sl);
            const closure = await detectClosure(pair, signal.direction, tp, sl, postEntry);
            const result = closure?.result ?? null;
            const closePrice = closure?.closePrice ?? null;
            const closeDate = closure?.closeDate ?? null;

            if (result) {
                try {
                    await fetch(`${FIREBASE_URL}/mega/signals/${signal._fbKey}.json`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            result,
                            closePrice,
                            closedAt: new Date(closeDate).toISOString(),
                        }),
                    });
                    console.log(`  ${result === 'WIN' ? '\u2705' : '\u274c'} ${pair} ${signal.direction} cloture - ${result} @ ${closePrice} (bougie ${closeDate})`);
                } catch (e) {
                    console.error(`checkTrades: erreur ecriture cloture ${pair}:`, e.message);
                }
            }
        }
    }
}

async function runScan() {
    // La vérification des trades actifs tourne à chaque tick — checkTrades()
    // gère lui-même le blocage week-end en interne.
    await checkTrades();

    // Pas de nouveaux signaux le week-end (marché forex fermé).
    if (!isMarketOpen()) {
        console.log(`[${new Date().toISOString()}] Marché fermé (week-end), scan de nouveaux signaux ignoré.`);
        return;
    }

    // On scanne DÉSORMAIS 24h/24 (jour ET nuit). La session détermine:
    //   - quelle clé Twelve Data utiliser (quota séparé par clé)
    //   - le tag "session" du signal (jour = exécuté IG, nuit = stats seulement)
    const session = currentSession();
    const apiKey = session === 'jour' ? DAY_KEY : NIGHT_KEY;

    console.log(`[${new Date().toISOString()}] Début du scan [${session}]...`);
    scanCount++;

    const candlesByPairTf = await fetchAllCandles(apiKey);
    const detectedSignals = [];

    // NOTE: pas de restriction "1 trade par paire" côté serveur pendant la phase
    // de test — chaque combo produit ses signaux indépendamment pour mesurer sa
    // performance propre. Le "1 trade/paire" est géré côté exécuteur IG.

    for (const combo of COMBOS) {
        const candles = candlesByPairTf[combo.pair]?.[combo.timeframe];
        if (!candles || candles.length < 100) {
            console.log(`  ⚠️ ${combo.pair} ${combo.timeframe}: données insuffisantes, combo ignoré.`);
            continue;
        }

        const allSignals = computeAllSignals(candles);
        const matches = comboMatches(allSignals, combo.signals);

        if (matches) {
            // Anti-duplication: ne pas re-signaler la même paire/direction
            // si un signal a déjà été émis il y a moins d'1h
            const lastTime = await getLastSignalTime(combo.pair, combo.direction);
            const now = Date.now();
            if (lastTime && (now - lastTime) < MIN_RESCAN_GAP_MS) {
                console.log(`  ⏭️ ${combo.pair} ${combo.direction}: déjà signalé il y a moins d'1h, ignoré.`);
                continue;
            }

            const slTp = computeSlTp(candles, combo.direction);
            if (!slTp) {
                console.log(`  ⚠️ ${combo.pair} ${combo.direction}: ATR invalide, signal ignoré.`);
                continue;
            }

            const signalRecord = {
                pair: combo.pair,
                direction: combo.direction,
                timeframe: combo.timeframe,
                signals_combo: combo.signals,
                entry_price: slTp.entryPrice,
                sl: slTp.sl,
                tp: slTp.tp,
                atr: slTp.atr,
                session, // "jour" ou "nuit" — l'exécuteur IG n'ouvre QUE les "jour"
            };

            console.log(`  ✅ SIGNAL [${session}]: ${combo.pair} ${combo.direction} [${combo.timeframe}] entrée=${slTp.entryPrice.toFixed(5)} SL=${slTp.sl.toFixed(5)} TP=${slTp.tp.toFixed(5)}`);

            await logSignal(signalRecord);
            await setLastSignalTime(combo.pair, combo.direction, now);
            detectedSignals.push(signalRecord);
        }
    }

    lastScanResults = { timestamp: new Date().toISOString(), session, signals: detectedSignals };
    console.log(`[${new Date().toISOString()}] Scan [${session}] terminé: ${detectedSignals.length} signal(aux) détecté(s).`);
}

// ─── ENDPOINTS HTTP ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        status: 'MEGA server actif',
        combos_actifs: COMBOS.length,
        paires: PAIRS,
        mode: 'scan 24h/24',
        session_courante: currentSession(),
        fenetre_jour: `${ACTIVE_HOUR_START}h-${ACTIVE_HOUR_END}h Paris (exécuté sur IG)`,
        fenetre_nuit: `${NIGHT_HOUR_START}h-${NIGHT_HOUR_END}h Paris (stats seulement)`,
        intervalle_scan_minutes: SCAN_INTERVAL_MS / 60000,
        scans_effectues: scanCount,
        erreurs: errorCount,
        dernier_scan: lastScanResults,
    });
});

app.get('/status', (req, res) => {
    res.json(lastScanResults);
});

app.get('/combos', (req, res) => {
    res.json(COMBOS);
});

app.all('/reset', async (req, res) => {
    try {
        await fetch(`${FIREBASE_URL}/mega/signals.json`, { method: 'DELETE' });
        await fetch(`${FIREBASE_URL}/mega/lastSignalTime.json`, { method: 'DELETE' });
        lastScanResults = { timestamp: null, signals: [] };
        console.log(`[${new Date().toISOString()}] Reset effectué: signals + lastSignalTime supprimés.`);
        res.json({ status: 'ok', message: 'signals et lastSignalTime supprimés' });
    } catch (e) {
        console.error('Erreur reset:', e.message);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.all('/recheck-all', async (req, res) => {
    // Re-vérifie TOUS les trades déjà clôturés (result WIN/LOSS) avec la
    // logique chronologique par bougies, et corrige ceux dont le résultat
    // stocké ne correspond pas à ce qui s'est réellement passé sur le marché.
    // Utile pour rattraper les clôtures erronées produites par l'ancienne
    // méthode "prix instantané". À appeler une fois, puis laisser.
    let signals;
    try {
        const r = await fetch(`${FIREBASE_URL}/mega/signals.json`);
        const data = await r.json();
        signals = data
            ? Object.entries(data)
                  .filter(([, s]) => s.result === 'WIN' || s.result === 'LOSS')
                  .map(([key, s]) => ({ ...s, _fbKey: key }))
            : [];
    } catch (e) {
        return res.status(500).json({ status: 'error', message: e.message });
    }

    const decodePair = p => p.replace('_', '/');
    const corrections = [];
    let checked = 0, errors = 0;

    // Regroupe par paire pour minimiser les requêtes
    const byPair = {};
    for (const s of signals) {
        const pair = decodePair(s.pair);
        (byPair[pair] = byPair[pair] || []).push(s);
    }

    for (const [pair, sigs] of Object.entries(byPair)) {
        const earliestTs = Math.min(...sigs.map(s => new Date(s.timestamp).getTime()));
        let candles;
        try {
            candles = await fetchCandlesSince(pair, earliestTs);
        } catch (e) {
            errors++;
            console.error(`recheck-all: erreur bougies ${pair}:`, e.message);
            continue;
        }
        if (!candles.length) continue;

        for (const signal of sigs) {
            checked++;
            const entryTs = new Date(signal.timestamp).getTime();
            const postEntry = candles.filter(c => new Date(c.datetime).getTime() > entryTs);
            if (!postEntry.length) continue;

            const tp = parseFloat(signal.tp);
            const sl = parseFloat(signal.sl);
            const closure = await detectClosure(pair, signal.direction, tp, sl, postEntry);
            const trueResult = closure?.result ?? null;
            const closePrice = closure?.closePrice ?? null;
            const closeDate = closure?.closeDate ?? null;

            if (trueResult && trueResult !== signal.result) {
                try {
                    await fetch(`${FIREBASE_URL}/mega/signals/${signal._fbKey}.json`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            result: trueResult,
                            closePrice,
                            closedAt: new Date(closeDate).toISOString(),
                        }),
                    });
                    corrections.push({ pair, direction: signal.direction, ancien: signal.result, corrige: trueResult, date: closeDate });
                    console.log(`  🔧 CORRIGÉ ${pair} ${signal.direction}: ${signal.result} → ${trueResult} (bougie ${closeDate})`);
                } catch (e) {
                    errors++;
                    console.error(`recheck-all: erreur écriture ${pair}:`, e.message);
                }
            }
        }
    }

    console.log(`[${new Date().toISOString()}] Recheck-all terminé: ${checked} vérifiés, ${corrections.length} corrigés, ${errors} erreurs.`);
    res.json({ status: 'ok', verifies: checked, corriges: corrections.length, erreurs: errors, corrections });
});

app.all('/analyse-filtre', async (req, res) => {
    // Espérance NETTE après spread, sur les trades MEGA réellement clôturés.
    //
    // Le win rate seul ne suffit pas à décider: un SL serré donne un WR plus
    // élevé (TP plus facile à atteindre) mais un ratio dégradé par le spread.
    // Un SL large donne l'inverse. Seule l'espérance en pips NETS tranche.
    //
    //   WIN  -> gain réel  = distance_TP - spread
    //   LOSS -> perte réelle = distance_SL + spread
    let signals;
    try {
        const r = await fetch(`${FIREBASE_URL}/mega/signals.json`);
        const data = await r.json();
        signals = data
            ? Object.values(data).filter(s => s.result === 'WIN' || s.result === 'LOSS')
            : [];
    } catch (e) {
        return res.status(500).json({ status: 'error', message: e.message });
    }

    const mkBucket = () => ({ trades: 0, wins: 0, pips_nets: 0, R: 0 });
    const groupes = { sl_serre: mkBucket(), sl_large: mkBucket() };
    const parPaire = {};
    const parCombo = {}; // paire + direction

    for (const s of signals) {
        const pair = s.pair;
        const spread = SPREADS_PIPS[pair];
        if (spread === undefined) continue;

        const entry = parseFloat(s.entry_price);
        const sl = parseFloat(s.sl);
        const tp = parseFloat(s.tp);
        if (!isFinite(entry) || !isFinite(sl) || !isFinite(tp)) continue;

        const slPips = slDistancePips(pair, entry, sl);
        const tpPips = slDistancePips(pair, entry, tp);
        if (!isFinite(slPips) || slPips <= 0) continue;

        // Pips NETS réellement encaissés/perdus, spread déduit
        const pipsNets = s.result === 'WIN' ? (tpPips - spread) : -(slPips + spread);

        // IMPORTANT — mesure en R (multiples de risque):
        // l'exécuteur IG dimensionne chaque position pour risquer 20€ FIXES.
        // Une perte de 30 pips (SL large) coûte donc autant qu'une perte de
        // 3 pips (SL serré): 20€. Compter en pips bruts surpondère donc les
        // trades à SL large. La vraie mesure économique est le multiple de
        // risque: R = pips_nets / risque_reel_en_pips (= SL + spread).
        const risquePips = slPips + spread;
        const R = pipsNets / risquePips; // LOSS -> -1.00 ; WIN -> +(TP-spread)/(SL+spread)

        const serre = slPips < minSlPips(pair);
        const g = serre ? groupes.sl_serre : groupes.sl_large;
        g.trades++; g.pips_nets += pipsNets; g.R += R;
        if (s.result === 'WIN') g.wins++;

        if (!parPaire[pair]) parPaire[pair] = mkBucket();
        parPaire[pair].trades++; parPaire[pair].pips_nets += pipsNets; parPaire[pair].R += R;
        if (s.result === 'WIN') parPaire[pair].wins++;

        const ck = `${pair}_${s.direction}`;
        if (!parCombo[ck]) parCombo[ck] = mkBucket();
        parCombo[ck].trades++; parCombo[ck].pips_nets += pipsNets; parCombo[ck].R += R;
        if (s.result === 'WIN') parCombo[ck].wins++;
    }

    const RISQUE_EUR = 20; // doit correspondre à RISK_PER_TRADE de l'exécuteur IG

    // Finalise un bucket. La métrique qui DÉCIDE est esperance_R (et son
    // équivalent en euros); les pips ne sont donnés qu'à titre indicatif.
    const fin = b => ({
        trades: b.trades,
        win_rate: b.trades ? Math.round(b.wins / b.trades * 100) : null,
        esperance_R: b.trades ? Math.round(b.R / b.trades * 1000) / 1000 : null,
        esperance_EUR: b.trades ? Math.round(b.R / b.trades * RISQUE_EUR * 100) / 100 : null,
        total_EUR: Math.round(b.R * RISQUE_EUR * 100) / 100,
        pips_nets_total: Math.round(b.pips_nets * 10) / 10,
    });

    const finTrie = obj => Object.fromEntries(
        Object.entries(obj)
            .map(([k, b]) => [k, fin(b)])
            .sort((a, b) => (b[1].esperance_R ?? -99) - (a[1].esperance_R ?? -99))
    );

    const out = {
        lecture: `esperance_EUR = gain/perte moyen par trade en euros (risque ${RISQUE_EUR}€/trade, spread déduit). POSITIF = rentable. C'est LA métrique qui décide — pas les pips, car le sizing normalise le risque.`,
        global: fin(Object.values(groupes).reduce((a, b) => ({
            trades: a.trades + b.trades, wins: a.wins + b.wins,
            pips_nets: a.pips_nets + b.pips_nets, R: a.R + b.R,
        }), mkBucket())),
        par_groupe_SL: { sl_serre: fin(groupes.sl_serre), sl_large: fin(groupes.sl_large) },
        par_combo: finTrie(parCombo),
        par_paire: finTrie(parPaire),
    };

    console.log(`[${new Date().toISOString()}] Analyse: global ${out.global.esperance_EUR}€/trade (${out.global.total_EUR}€ au total)`);
    res.json(out);
});

app.all('/purge', async (req, res) => {
    // Supprime les signaux MEGA dont le timestamp tombe dans une fenêtre.
    // Paramètres (heure de PARIS):
    //   ?from=2026-07-13T17:00&to=2026-07-14T15:20
    //   &confirm=oui   -> exécute réellement la suppression
    // SANS &confirm=oui, la route ne fait qu'un APERÇU (aucune suppression).
    const { from, to, confirm } = req.query;
    if (!from || !to) {
        return res.status(400).json({
            status: 'error',
            message: "Paramètres 'from' et 'to' requis (heure de Paris). Ex: /purge?from=2026-07-13T17:00&to=2026-07-14T15:20",
        });
    }

    // Interprète les dates fournies comme de l'heure de PARIS.
    // Méthode fiable: on prend la date en supposant UTC, puis on mesure le
    // décalage réel de Paris à cet instant (gère été/hiver) et on l'applique.
    const parisToUtc = (str) => {
        const naive = new Date(str.length <= 16 ? str + ':00Z' : str + 'Z');
        if (isNaN(naive)) return null;
        // Que vaut cet instant UTC lu en heure de Paris ?
        const asParis = new Date(naive.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
        const asUtc = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' }));
        const offsetMs = asParis - asUtc; // +2h en été, +1h en hiver
        return new Date(naive.getTime() - offsetMs);
    };

    const fromDate = parisToUtc(from);
    const toDate = parisToUtc(to);
    if (!fromDate || !toDate) {
        return res.status(400).json({ status: 'error', message: 'Dates invalides. Format attendu: 2026-07-13T17:00' });
    }

    let data;
    try {
        const r = await fetch(`${FIREBASE_URL}/mega/signals.json`);
        data = await r.json();
    } catch (e) {
        return res.status(500).json({ status: 'error', message: e.message });
    }
    if (!data) return res.json({ status: 'ok', message: 'Aucun signal en base.', supprimes: 0 });

    const cibles = [];
    for (const [key, s] of Object.entries(data)) {
        const ts = new Date(s.timestamp).getTime();
        if (!isFinite(ts)) continue;
        if (ts >= fromDate.getTime() && ts <= toDate.getTime()) {
            cibles.push({
                key,
                pair: s.pair,
                direction: s.direction,
                result: s.result ?? 'ACTIF',
                timestamp: s.timestamp,
                heure_paris: new Date(s.timestamp).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
            });
        }
    }

    // Sécurité: sans confirm=oui, on ne fait qu'un aperçu.
    if (confirm !== 'oui') {
        return res.json({
            status: 'APERCU',
            message: `${cibles.length} signal(aux) SERAIENT supprimés. Rien n'a été supprimé. Pour exécuter, rajoute &confirm=oui à l'URL.`,
            fenetre_paris: { from, to },
            fenetre_utc: { from: fromDate.toISOString(), to: toDate.toISOString() },
            a_supprimer: cibles,
        });
    }

    let supprimes = 0, erreurs = 0;
    for (const c of cibles) {
        try {
            await fetch(`${FIREBASE_URL}/mega/signals/${c.key}.json`, { method: 'DELETE' });
            supprimes++;
        } catch (e) {
            erreurs++;
            console.error(`purge: erreur suppression ${c.key}:`, e.message);
        }
    }

    console.log(`[${new Date().toISOString()}] PURGE: ${supprimes} signaux supprimés (${from} -> ${to} Paris), ${erreurs} erreurs.`);
    res.json({ status: 'ok', supprimes, erreurs, fenetre_paris: { from, to }, details: cibles });
});

app.listen(PORT, () => {
    console.log(`MEGA server démarré sur le port ${PORT}`);
    console.log(`${COMBOS.length} combos actifs sur ${PAIRS.length} paires`);
    console.log(`Fenêtre active: ${ACTIVE_HOUR_START}h-${ACTIVE_HOUR_END}h Paris, scan toutes les ${SCAN_INTERVAL_MS / 60000} min`);

    // Premier scan immédiat au démarrage, puis boucle régulière
    runScan();
    setInterval(runScan, SCAN_INTERVAL_MS);
});
