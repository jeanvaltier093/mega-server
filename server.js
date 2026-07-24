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

// CORRECTIF (22/07): isMarketOpen() ci-dessus ne regarde que "maintenant" —
// utile pour checkTrades() en temps réel (bloque le scan PENDANT le
// week-end), mais /recheck-all retraite l'historique PASSÉ : un signal du
// dimanche 5 juillet, relu un mardi, passait ce garde-fou sans problème
// puisque "maintenant" n'est pas un dimanche. Résultat vécu en pratique :
// /recheck-all a "corrigé" 3 signaux nés un dimanche (marché fermé) en
// leur donnant un nouveau résultat tout aussi fictif que l'ancien. Cette
// version prend l'horodatage DU SIGNAL, pas l'heure actuelle, et utilise
// New York (ouverture/fermeture réelles du forex) plutôt que Paris, pour
// ne pas dépendre de deux bascules DST différentes (US/UE).
function isMarketOpenAt(tsMs) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date(tsMs));
    const g = (t) => parts.find(p => p.type === t).value;
    const jour = g('weekday');
    const heure = parseInt(g('hour'), 10) + parseInt(g('minute'), 10) / 60;
    if (jour === 'Sat') return false;
    if (jour === 'Sun' && heure < 17) return false;
    if (jour === 'Fri' && heure >= 17) return false;
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

// CORRECTIF (21/07 ter): limiteur INDÉPENDANT pour le croisement M1.
// BUG CORRIGÉ: fetchM1Window utilisait waitForRateLimit() — le MÊME
// compteur partagé que fetchCandlesSince/fetchAllCandles — alors que le
// croisement M1 utilise une clé Twelve Data SÉPARÉE (M1_CHECK_TWELVE_KEY)
// avec son propre quota. Résultat: un /recheck-all sur ~160 trades pouvait
// mettre ~35-40 minutes à finir, freiné par un débit partagé qui n'avait
// plus de raison d'être commun. Chaque clé a maintenant sa propre file.
const requestTimestampsM1 = [];

async function waitForRateLimitM1() {
    const now = Date.now();
    while (requestTimestampsM1.length && now - requestTimestampsM1[0] > RATE_LIMIT_WINDOW_MS) {
        requestTimestampsM1.shift();
    }
    if (requestTimestampsM1.length >= RATE_LIMIT_MAX_REQUESTS) {
        const waitMs = RATE_LIMIT_WINDOW_MS - (now - requestTimestampsM1[0]) + 200;
        await sleep(waitMs);
        return waitForRateLimitM1();
    }
    requestTimestampsM1.push(Date.now());
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
const M1_CHECK_TWELVE_KEY = process.env.M1_CHECK_TWELVE_KEY || '8d43f79abb1f41e2b3e2da29e344c7fa';

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

const PLAUSIBILITY_MAX_ATR_MULT = 4;
// Version de la logique de détection de clôture — à incrémenter à CHAQUE
// changement significatif de detectClosure(). CORRECTIF (21/07): l'ancien
// marquage `m1_verified: true` était un simple booléen, sans mémoire de
// QUELLE version l'avait posé. Quand on a retiré le blocage ATR (le M1 a
// désormais toujours le dernier mot), les trades déjà marqués par
// l'ANCIENNE version ne se sont JAMAIS fait revérifier par la nouvelle
// règle — le mode incrémental les sautait à tort, les croyant à jour.
// Avec un numéro de version, changer la logique invalide automatiquement
// les anciennes vérifications, sans dépendre d'un ?full=1 fragile.
const DETECT_LOGIC_VERSION = 5; // v1: naïf ; v2: ATR+confirmation ; v3: M1 systématique (ATR non bloquant) ; v4: spread déduit + ambiguïté TP/SL explicite (22/07) ; v5: garde-fou hors-marché ajouté à /recheck-all APRÈS qu'un premier lot ait déjà été tamponné v4 sans lui — sans ce nouveau numéro, ce lot restait invisible pour toujours (m1_verified_version < DETECT_LOGIC_VERSION ne le reprend jamais)

// Récupère les bougies M1 (1 minute) d'une fenêtre précise — utilisé
// UNIQUEMENT pour revalider une bougie M15 qui semble toucher TP/SL,
// avant d'accepter le résultat. Fenêtre étroite = coût API minime (1 appel
// par clôture détectée, pas par bougie scannée).
async function fetchM1Window(pair, fromMs, toMs) {
    await waitForRateLimitM1();
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=1min&start_date=${encodeURIComponent(fmt(new Date(fromMs)))}&end_date=${encodeURIComponent(fmt(new Date(toMs)))}&outputsize=30&apikey=${M1_CHECK_TWELVE_KEY}&format=JSON&timezone=UTC`;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        if (!d.values || d.status === 'error') {
            // DIAGNOSTIC (21/07): avant, cet échec était silencieux (repli
            // muet). On remonte maintenant la VRAIE raison — sans ça,
            // impossible de savoir si le croisement M1 fonctionne
            // réellement ou échoue à chaque appel sans que rien ne le montre.
            return { values: null, error: d.message || d.code || JSON.stringify(d).slice(0, 200) };
        }
        return { values: d.values.reverse(), error: null };
    } catch (e) {
        return { values: null, error: `exception: ${e.message}` };
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
 * de bloquer toute détection de clôture), MAIS on le SIGNALE désormais
 * explicitement via m1Status, au lieu de le passer sous silence.
 */
// ─── CORRECTIF SPREAD (22/07) ──────────────────────────────────────────────
// Les bougies Twelve Data (comme Dukascopy) donnent un prix MOYEN / bid, pas
// le prix auquel IG t'exécute réellement. Pour sortir d'une position :
//   - BUY  -> tu VENDS pour sortir -> exécuté au prix BID (plus bas que le mid)
//   - SELL -> tu ACHETES pour sortir -> exécuté au prix ASK (plus haut que le mid)
// Vu depuis une bougie en prix moyen, ton SL/TP réel est donc DÉCALÉ d'un
// demi-spread selon le sens :
//   BUY  : SL réel = SL + demi-spread   | TP réel = TP + demi-spread
//   SELL : SL réel = SL - demi-spread   | TP réel = TP - demi-spread
// Confirmé le 22/07 sur un trade réel (USD/JPY 16/07: SL théorique
// 162.55821, jamais atteint en vue "Moyenne" (162.548) mais bien dépassé en
// vue "Achat" (162.553), soit l'écart d'un demi-spread).
function pipSizeForPair(pairSlash) {
    return pairSlash.endsWith('JPY') ? 0.01 : 0.0001;
}
function spreadPipsForPair(pairSlash) {
    const key = pairSlash.replace('/', '_');
    const s = SPREADS_PIPS[key];
    return s === undefined ? 0 : s;
}
function applySpread(pair, direction, tp, sl) {
    const pip = pipSizeForPair(pair);
    const halfSpread = (spreadPipsForPair(pair) / 2) * pip;
    if (direction === 'BUY') {
        return { tpReal: tp + halfSpread, slReal: sl + halfSpread };
    }
    return { tpReal: tp - halfSpread, slReal: sl - halfSpread };
}

async function detectClosure(pair, direction, tp, sl, postEntry) {
    const { tpReal, slReal } = applySpread(pair, direction, tp, sl);

    for (let i = 0; i < postEntry.length; i++) {
        const c = postEntry[i];
        const high = parseFloat(c.high), low = parseFloat(c.low);

        const atr = computeATR(postEntry.slice(0, i + 1));
        const amplitude = high - low;
        const amplitudeSuspecte = atr && amplitude > atr * PLAUSIBILITY_MAX_ATR_MULT;

        // CORRECTIF (22/07): AVANT, le TP était TOUJOURS testé en premier
        // (if tp ... else if sl ...) — une bougie qui touchait les DEUX
        // niveaux dans le même intervalle de 15 minutes était donc TOUJOURS
        // comptée gagnante, quel que soit l'ordre réel des événements à
        // l'intérieur de la bougie. Ça gonfle mécaniquement le taux de
        // réussite. On ne peut pas savoir, avec des données M15, lequel des
        // deux a été touché en premier : les DEUX conditions sont donc
        // évaluées, et le cas où les deux sont vraies devient une catégorie
        // explicite ('AMBIGU'), jamais une victoire par défaut.
        const tpTouched = direction === 'BUY' ? high >= tpReal : low <= tpReal;
        const slTouched = direction === 'BUY' ? low <= slReal : high >= slReal;

        let touched = null; // 'WIN' | 'LOSS' | 'AMBIGU' | null
        if (tpTouched && slTouched) touched = 'AMBIGU';
        else if (tpTouched) touched = 'WIN';
        else if (slTouched) touched = 'LOSS';
        if (!touched) continue;

        if (amplitudeSuspecte) {
            console.log(`  ℹ️  ${pair}: bougie d'amplitude inhabituelle (${amplitude.toFixed(5)} vs ATR ${atr.toFixed(5)}) — soumise au M1 pour arbitrage, pas rejetée d'office.`);
        }

        if (touched === 'AMBIGU') {
            // Zone grise assumée : ni WIN ni LOSS forcé. On tente le zoom M1
            // pour désambiguïser (un seul des deux niveaux touché, minute par
            // minute, chronologiquement) ; sinon on remonte 'AMBIGU' tel
            // quel plutôt que de deviner.
            const windowStart = new Date(c.datetime).getTime() - 60000;
            const windowEnd = windowStart + 17 * 60000;
            let { values: m1, error: m1Error } = await fetchM1Window(pair, windowStart, windowEnd);
            if (!m1) {
                ({ values: m1, error: m1Error } = await fetchM1Window(pair, windowStart, windowEnd));
            }
            if (m1 && m1.length) {
                for (const m of m1) {
                    const mh = parseFloat(m.high), ml = parseFloat(m.low);
                    const mTp = direction === 'BUY' ? mh >= tpReal : ml <= tpReal;
                    const mSl = direction === 'BUY' ? ml <= slReal : mh >= slReal;
                    if (mTp && mSl) continue; // toujours ambigu à cette minute, on avance
                    if (mTp) return { result: 'WIN', closePrice: tp, closeDate: m.datetime, m1Status: { checked: true, confirmed: true, error: null, amplitudeSuspecte, desambiguise: true } };
                    if (mSl) return { result: 'LOSS', closePrice: sl, closeDate: m.datetime, m1Status: { checked: true, confirmed: true, error: null, amplitudeSuspecte, desambiguise: true } };
                }
            }
            return { result: 'AMBIGU', closePrice: null, closeDate: c.datetime, m1Status: { checked: !!(m1 && m1.length), confirmed: false, error: m1Error || null, amplitudeSuspecte, desambiguise: false } };
        }

        // Validation croisée M1 sur la fenêtre de cette bougie M15 (+ marge).
        const windowStart = new Date(c.datetime).getTime() - 60000;
        const windowEnd = windowStart + 17 * 60000;
        let { values: m1, error: m1Error } = await fetchM1Window(pair, windowStart, windowEnd);
        if (!m1) {
            ({ values: m1, error: m1Error } = await fetchM1Window(pair, windowStart, windowEnd));
        }

        let m1Status;
        if (m1 && m1.length) {
            const confirmed = m1.some((m) => {
                const mh = parseFloat(m.high), ml = parseFloat(m.low);
                if (direction === 'BUY') {
                    return touched === 'WIN' ? mh >= tpReal : ml <= slReal;
                } else {
                    return touched === 'WIN' ? ml <= tpReal : mh >= slReal;
                }
            });
            if (!confirmed) {
                continue; // la bougie M15 ne résiste pas au zoom M1 — probable artefact
            }
            m1Status = { checked: true, confirmed: true, error: null, amplitudeSuspecte };
        } else {
            m1Status = { checked: false, confirmed: null, error: m1Error, amplitudeSuspecte };
        }

        return { result: touched, closePrice: touched === 'WIN' ? tp : sl, closeDate: c.datetime, m1Status };
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

            // AMBIGU (22/07) : ni WIN ni LOSS, on ne clôture PAS le trade —
            // on laisse le prochain scan retenter avec plus de bougies,
            // plutôt que d'enregistrer un résultat qu'on ne peut pas garantir.
            if (result === 'AMBIGU') {
                console.log(`  \u2753 ${pair} ${signal.direction} : bougie ambiguë (TP et SL tous deux dans la même bougie M15, non désambiguïsée par M1) — laissé ouvert, retenté au prochain scan.`);
                continue;
            }

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
    // méthode "prix instantané".
    //
    // OPTIMISATION (21/07): chaque trade dont la clôture a été confirmée
    // par le croisement M1 est marqué `m1_verified`. Les appels SUIVANTS
    // ignorent ces trades déjà vérifiés — seuls les NOUVEAUX trades clôturés
    // depuis le dernier passage sont revérifiés. Passe ?full=1 pour forcer
    // une revérification complète malgré tout.
    //
    // CORRECTIF (21/07 quinquies): une seule requête HTTP couvrant ~160
    // trades avec croisement M1 dure 40-90+ minutes — largement au-delà de
    // ce que Cloudflare/Render tolèrent pour UNE requête (502 Bad Gateway
    // constaté en pratique, la connexion coupée avant la fin, même si le
    // travail déjà fait restait intact dans Firebase). Un paramètre `limit`
    // borne désormais le nombre de trades traités par appel — répéter
    // l'appel (même URL, sans rien changer) reprend automatiquement là où
    // le précédent s'est arrêté, grâce au marquage m1_verified. Défaut: 15
    // trades par appel (~4 minutes), largement sous tout timeout usuel.
    const forceAll = req.query.full === '1';
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 15));
    let signals, totalRestants;
    try {
        const r = await fetch(`${FIREBASE_URL}/mega/signals.json`);
        const data = await r.json();
        const eligibles = data
            ? Object.entries(data)
                  .filter(([, s]) => (s.result === 'WIN' || s.result === 'LOSS') && s.verifie_par !== 'ig_pnl_reel' && (forceAll || (s.m1_verified_version || 0) < DETECT_LOGIC_VERSION))
                  // CORRECTIF (21/07 sexies): un trade déjà confirmé par le
                  // VRAI P&L payé par IG (marqué verifie_par:'ig_pnl_reel'
                  // par /verify-ig&fix=1 sur l'exécuteur) ne doit JAMAIS être
                  // reconsidéré ici. /recheck-all ne fait que de la
                  // cohérence interne à Twelve Data (bougies M15 vs M1) —
                  // une preuve plus faible qu'un P&L réellement encaissé.
                  // Sans cette exclusion, une reconstruction Twelve Data
                  // pourrait écraser à tort un résultat déjà prouvé par
                  // l'argent réel — même ?full=1 ne doit jamais y toucher.
                  .map(([key, s]) => ({ ...s, _fbKey: key }))
            : [];
        totalRestants = eligibles.length;
        signals = eligibles.slice(0, limit);
    } catch (e) {
        return res.status(500).json({ status: 'error', message: e.message });
    }

    const decodePair = p => p.replace('_', '/');
    const corrections = [];
    let checked = 0, errors = 0;
    let m1Confirmed = 0, m1FailedOpen = 0;
    let ambiguous = 0;
    const horsMarcheRecheck = [];
    let firebaseWriteErrors = 0;
    const m1ErrorSamples = [];

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

            // CORRECTIF (22/07): un signal né hors des heures de marché
            // (week-end) n'a jamais eu de résultat réel possible — le WIN ou
            // LOSS déjà stocké est lui-même un artefact (Twelve Data renvoie
            // des bougies figées de vendredi soir quand le marché est
            // fermé). On ne lui invente pas un NOUVEAU résultat : on le
            // marque hors_marche et on l'exclut, sans jamais toucher `result`.
            if (!isMarketOpenAt(entryTs)) {
                horsMarcheRecheck.push({ pair, direction: signal.direction, date: signal.timestamp, ancien_resultat: signal.result });
                try {
                    await fetch(`${FIREBASE_URL}/mega/signals/${signal._fbKey}.json`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ hors_marche: true, m1_verified_version: DETECT_LOGIC_VERSION }),
                    });
                } catch (e) {
                    console.error(`recheck-all: erreur marquage hors_marche ${pair}:`, e.message);
                }
                continue;
            }

            const postEntry = candles.filter(c => new Date(c.datetime).getTime() > entryTs);
            if (!postEntry.length) continue;

            const tp = parseFloat(signal.tp);
            const sl = parseFloat(signal.sl);
            const closure = await detectClosure(pair, signal.direction, tp, sl, postEntry);
            const trueResult = closure?.result ?? null;
            const closePrice = closure?.closePrice ?? null;
            const closeDate = closure?.closeDate ?? null;

            if (closure?.m1Status) {
                if (closure.m1Status.checked && closure.m1Status.confirmed) {
                    m1Confirmed++;
                } else if (!closure.m1Status.checked) {
                    m1FailedOpen++;
                    if (m1ErrorSamples.length < 5) m1ErrorSamples.push(closure.m1Status.error);
                }
            }

            // AMBIGU (22/07) : jamais écrit comme correction — ni WIN ni
            // LOSS forcé, on préfère laisser l'ancien résultat en place
            // (potentiellement lui-même à revérifier plus tard) plutôt que
            // d'écraser avec une valeur qu'on ne peut pas garantir.
            if (trueResult === 'AMBIGU') {
                ambiguous++;
                continue;
            }

            if (trueResult && trueResult !== signal.result) {
                try {
                    const patchRes = await fetch(`${FIREBASE_URL}/mega/signals/${signal._fbKey}.json`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            result: trueResult,
                            closePrice,
                            closedAt: new Date(closeDate).toISOString(),
                            m1_verified_version: DETECT_LOGIC_VERSION,
                        }),
                    });
                    if (!patchRes.ok) {
                        // CORRECTIF (21/07): fetch() ne lève PAS d'exception sur une
                        // erreur HTTP (400/404/...), seulement sur un échec réseau —
                        // sans cette vérification explicite, une écriture REFUSÉE par
                        // Firebase passait pour une réussite silencieuse, et
                        // m1_verified n'était jamais réellement posé.
                        const body = await patchRes.text().catch(() => '');
                        errors++;
                        firebaseWriteErrors++;
                        console.error(`recheck-all: écriture refusée par Firebase (${patchRes.status}) pour ${pair}: ${body.slice(0, 200)}`);
                    } else {
                        corrections.push({ pair, direction: signal.direction, ancien: signal.result, corrige: trueResult, date: closeDate });
                        console.log(`  🔧 CORRIGÉ ${pair} ${signal.direction}: ${signal.result} → ${trueResult} (bougie ${closeDate})`);
                    }
                } catch (e) {
                    errors++;
                    firebaseWriteErrors++;
                    console.error(`recheck-all: erreur écriture ${pair}:`, e.message);
                }
            } else if (trueResult) {
                // Concordant : pas de correction nécessaire, mais on marque
                // quand même le trade comme vérifié pour ne plus le
                // retraiter lors des prochains appels.
                try {
                    const patchRes = await fetch(`${FIREBASE_URL}/mega/signals/${signal._fbKey}.json`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ m1_verified_version: DETECT_LOGIC_VERSION }),
                    });
                    if (!patchRes.ok) {
                        const body = await patchRes.text().catch(() => '');
                        errors++;
                        firebaseWriteErrors++;
                        console.error(`recheck-all: marquage refusé par Firebase (${patchRes.status}) pour ${pair}: ${body.slice(0, 200)}`);
                    }
                } catch (e) {
                    errors++;
                    firebaseWriteErrors++;
                    console.error(`recheck-all: erreur marquage ${pair}:`, e.message);
                }
            }
            // Si trueResult est null (clôture non trouvée dans les bougies
            // disponibles), on NE marque PAS m1_verified — ce trade sera
            // retenté au prochain appel plutôt que d'être abandonné.
        }
    }

    console.log(`[${new Date().toISOString()}] Recheck-all terminé: ${checked} vérifiés, ${corrections.length} corrigés, ${errors} erreurs. M1: ${m1Confirmed} confirmés, ${m1FailedOpen} repli (échec).`);
    const restantsApres = Math.max(0, totalRestants - signals.length);
    res.json({
        status: 'ok',
        mode: forceAll ? 'complet (?full=1)' : 'incrémental — seuls les trades non encore vérifiés par M1',
        lot: `${signals.length} trades traités ce lot (limit=${limit})`,
        // Combien reste-t-il APRÈS ce lot ? Si > 0, rappelle EXACTEMENT la
        // même URL — le marquage m1_verified fait que la suite reprend
        // automatiquement où ce lot s'est arrêté. Chaque lot dure ~4 min
        // (15 trades par défaut), largement sous les timeouts habituels.
        restants_apres_ce_lot: restantsApres,
        rappel_necessaire: restantsApres > 0 ? `OUI — relance la même URL, il reste ${restantsApres} trades à vérifier` : 'NON — tout est à jour',
        verifies: checked,
        corriges: corrections.length,
        erreurs: errors,
        // DIAGNOSTIC (21/07): preuve concrète que le croisement M1 a
        // réellement fonctionné, plutôt qu'un repli silencieux à chaque
        // fois. Si m1_repli_echec est élevé (proche de verifies), le
        // croisement M1 ne fait quasiment RIEN — vérifier la clé
        // M1_CHECK_TWELVE_KEY et les exemples d'erreur ci-dessous.
        m1_confirmes: m1Confirmed,
        m1_repli_echec: m1FailedOpen,
        // AMBIGU (22/07) : bougies où TP et SL ont tous deux été touchés
        // dans le même intervalle M15, sans qu'un zoom M1 les départage.
        // Jamais écrasés — ni comptés en correction, ni en erreur — juste
        // signalés ici pour transparence. Ancien résultat conservé tel quel.
        ambigus_non_tranches: ambiguous,
        // HORS_MARCHE (22/07): signaux nés hors des heures de marché
        // (week-end) — plus jamais recomptés WIN/LOSS ici, simplement
        // tagués hors_marche:true et exclus. Vérifie details_hors_marche si
        // ce nombre te surprend.
        hors_marche: horsMarcheRecheck.length,
        details_hors_marche: horsMarcheRecheck,
        // DIAGNOSTIC (21/07 bis): si ce chiffre n'est pas nul, Firebase a
        // REFUSÉ certaines écritures de m1_verified (voir logs Render pour
        // le détail) — ça expliquerait un blocage répété sur le même lot.
        firebase_erreurs_ecriture: firebaseWriteErrors,
        m1_exemples_erreurs: m1ErrorSamples,
        corrections,
    });
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
            ? Object.values(data).filter(s => (s.result === 'WIN' || s.result === 'LOSS') && !s.hors_marche)
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

// ─── AUDIT DE COHÉRENCE result/closePrice (24/07) ──────────────────────────
// Découvert via le dashboard: certaines corrections passées (avant le
// correctif du 24/07 sur mega-ig-executor.js) écrivaient un nouveau `result`
// sans mettre à jour `closePrice` en conséquence — laissant par exemple un
// trade marqué WIN avec un closePrice proche du SL (donc des pips négatifs
// une fois calculés depuis le vrai prix). Ce endpoint ne corrige RIEN tout
// seul: il liste chaque incohérence pour une correction manuelle réfléchie,
// car on ne peut pas déduire avec certitude si c'est `result` ou
// `closePrice` qui est faux — seul le contexte du trade (capture IG, etc.)
// permet de trancher, comme pour -OwcPa8UYtwXBgVLdZMz.
app.all('/audit-coherence', async (req, res) => {
    let signals;
    try {
        const r = await fetch(`${FIREBASE_URL}/mega/signals.json`);
        const data = await r.json();
        signals = data ? Object.entries(data) : [];
    } catch (e) {
        return res.status(500).json({ status: 'error', message: e.message });
    }

    const incoherents = [];
    let verifies = 0;

    for (const [key, s] of signals) {
        if (!s || (s.result !== 'WIN' && s.result !== 'LOSS')) continue;
        const cp = parseFloat(s.closePrice);
        const tp = parseFloat(s.tp);
        const sl = parseFloat(s.sl);
        if (!isFinite(cp) || !isFinite(tp) || !isFinite(sl)) continue;
        verifies++;

        const distTP = Math.abs(cp - tp);
        const distSL = Math.abs(cp - sl);
        // Incohérent si le closePrice enregistré est objectivement plus
        // proche du niveau OPPOSÉ à ce que dit `result`.
        const incoherent = (s.result === 'WIN' && distSL < distTP) || (s.result === 'LOSS' && distTP < distSL);

        if (incoherent) {
            incoherents.push({
                signalId: key,
                pair: s.pair,
                direction: s.direction,
                result_stocke: s.result,
                closePrice_stocke: cp,
                tp, sl,
                plus_proche_de: distSL < distTP ? 'SL' : 'TP',
                verifie_par: s.verifie_par || null,
                dukascopy_checked: s.dukascopy_checked || false,
                closedAt: s.closedAt || null,
                note: s.result === 'WIN'
                    ? "result=WIN mais closePrice plus proche du SL que du TP — probable closePrice non mis à jour après correction."
                    : "result=LOSS mais closePrice plus proche du TP que du SL — probable closePrice non mis à jour après correction.",
            });
        }
    }

    res.json({
        status: 'ok',
        signaux_avec_prix_verifiables: verifies,
        incoherents: incoherents.length,
        details_incoherents: incoherents,
        lecture: "Chaque entrée ci-dessus a un result et un closePrice qui se contredisent. Rien n'est corrigé automatiquement — vérifie chaque cas (capture IG si Groupe 1, ou juste bon sens si Groupe 2) avant de patcher closePrice manuellement.",
    });
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
