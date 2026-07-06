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
 
async function fetchAllCandles() {
    const candlesByPairTf = {};
    for (const [pair, tfs] of Object.entries(PAIR_TIMEFRAMES)) {
        candlesByPairTf[pair] = {};
        for (const tf of tfs) {
            await waitForRateLimit();
            try {
                const candles = await fetchCandles(pair, tf);
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
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '80ddd35489f3427d8c43f29c995d6372';
 
async function fetchCandlesSince(pair, sinceMs, interval = '15min') {
    await waitForRateLimit();
    const start = new Date(sinceMs);
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${interval}&start_date=${encodeURIComponent(fmt(start))}&outputsize=500&apikey=${TWELVE_DATA_API_KEY}&format=JSON&timezone=UTC`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (!d.values || d.status === 'error') throw new Error(d.message || 'Pas de donnees retournees');
    // Chronologique (ancien -> recent), on retire la derniere bougie qui peut
    // etre encore en cours de formation (high/low provisoires).
    return d.values.reverse().slice(0, -1);
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
            let result = null, closePrice = null, closeDate = null;
 
            for (const c of postEntry) {
                const high = parseFloat(c.high);
                const low = parseFloat(c.low);
                if (signal.direction === 'BUY') {
                    if (high >= tp) { result = 'WIN'; closePrice = tp; closeDate = c.datetime; break; }
                    if (low <= sl) { result = 'LOSS'; closePrice = sl; closeDate = c.datetime; break; }
                } else {
                    if (low <= tp) { result = 'WIN'; closePrice = tp; closeDate = c.datetime; break; }
                    if (high >= sl) { result = 'LOSS'; closePrice = sl; closeDate = c.datetime; break; }
                }
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
 
    if (!isWithinActiveHours()) {
        console.log(`[${new Date().toISOString()}] Hors fenêtre active (${ACTIVE_HOUR_START}h-${ACTIVE_HOUR_END}h Paris), scan ignoré.`);
        return;
    }
 
    console.log(`[${new Date().toISOString()}] Début du scan...`);
    scanCount++;
 
    const candlesByPairTf = await fetchAllCandles();
    const detectedSignals = [];
 
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
            };
 
            console.log(`  ✅ SIGNAL: ${combo.pair} ${combo.direction} [${combo.timeframe}] entrée=${slTp.entryPrice.toFixed(5)} SL=${slTp.sl.toFixed(5)} TP=${slTp.tp.toFixed(5)}`);
 
            await logSignal(signalRecord);
            await setLastSignalTime(combo.pair, combo.direction, now);
            detectedSignals.push(signalRecord);
        }
    }
 
    lastScanResults = { timestamp: new Date().toISOString(), signals: detectedSignals };
    console.log(`[${new Date().toISOString()}] Scan terminé: ${detectedSignals.length} signal(aux) détecté(s).`);
}
 
// ─── ENDPOINTS HTTP ────────────────────────────────────────────────────────────
 
app.get('/', (req, res) => {
    res.json({
        status: 'MEGA server actif',
        combos_actifs: COMBOS.length,
        paires: PAIRS,
        fenetre_active: `${ACTIVE_HOUR_START}h-${ACTIVE_HOUR_END}h Paris`,
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
            let trueResult = null, closePrice = null, closeDate = null;
 
            for (const c of postEntry) {
                const high = parseFloat(c.high);
                const low = parseFloat(c.low);
                if (signal.direction === 'BUY') {
                    if (high >= tp) { trueResult = 'WIN'; closePrice = tp; closeDate = c.datetime; break; }
                    if (low <= sl) { trueResult = 'LOSS'; closePrice = sl; closeDate = c.datetime; break; }
                } else {
                    if (low <= tp) { trueResult = 'WIN'; closePrice = tp; closeDate = c.datetime; break; }
                    if (high >= sl) { trueResult = 'LOSS'; closePrice = sl; closeDate = c.datetime; break; }
                }
            }
 
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
 
app.listen(PORT, () => {
    console.log(`MEGA server démarré sur le port ${PORT}`);
    console.log(`${COMBOS.length} combos actifs sur ${PAIRS.length} paires`);
    console.log(`Fenêtre active: ${ACTIVE_HOUR_START}h-${ACTIVE_HOUR_END}h Paris, scan toutes les ${SCAN_INTERVAL_MS / 60000} min`);
 
    // Premier scan immédiat au démarrage, puis boucle régulière
    runScan();
    setInterval(runScan, SCAN_INTERVAL_MS);
});
 
