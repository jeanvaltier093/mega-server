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
const RATE_LIMIT_MAX_REQUESTS = 7;
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

async function runScan() {
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

app.listen(PORT, () => {
    console.log(`MEGA server démarré sur le port ${PORT}`);
    console.log(`${COMBOS.length} combos actifs sur ${PAIRS.length} paires`);
    console.log(`Fenêtre active: ${ACTIVE_HOUR_START}h-${ACTIVE_HOUR_END}h Paris, scan toutes les ${SCAN_INTERVAL_MS / 60000} min`);

    // Premier scan immédiat au démarrage, puis boucle régulière
    runScan();
    setInterval(runScan, SCAN_INTERVAL_MS);
});
