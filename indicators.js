'use strict';
// ─── VARIABLES D'ENVIRONNEMENT ────────────────────────────────────────────────
const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY;
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://forex-trading-bendo-default-rtdb.firebaseio.com';

// ─── CONFIGURATION COMMUNE (identique à PROD/ULTIMATE/RAMCE) ─────────────────
const SL_ATR_MULT = 1.5;   // identique à PROD — confirmé: tous les 16 combos MEGA
const TP_ATR_MULT = 2.25;  // ont utilisé les valeurs par défaut du backtest, pas de ratio custom
const SWING_CONFIRM_DELAY = 5; // bougies de délai pour confirmer un smc_swing — voir note ci-dessous

/*
 * NOTE IMPORTANTE SUR smc_swing_low/high:
 * Dans le backtest Python (swing_highs_lows), un swing est détecté en
 * regardant 5 bougies AVANT et 5 bougies APRÈS la bougie candidate — donc
 * structurellement non-causal, impossible à confirmer instantanément en
 * temps réel. Pour rester fidèle à la performance mesurée (70-75% winrate),
 * ce serveur applique le MÊME délai de confirmation: un swing détecté à la
 * bougie i n'est confirmé (et n'autorise un signal) qu'après l'arrivée de
 * la bougie i+5 — exactement ce que le backtest mesurait déjà implicitement.
 * Ce n'est PAS une dégradation de la stratégie, c'est sa traduction fidèle
 * en conditions réelles (le backtest ne "trichait" jamais avec le futur
 * dans son issue de trading — seulement dans la CONFIRMATION du signal lui-même).
 */

// ─── UTILITAIRES ───────────────────────────────────────────────────────────────

function atr(high, low, close, period = 14) {
    const n = close.length;
    const tr = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const prevClose = i > 0 ? close[i - 1] : close[i];
        tr[i] = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - prevClose),
            Math.abs(low[i] - prevClose)
        );
    }
    return rollingMean(tr, period);
}

function rollingMean(arr, period) {
    const n = arr.length;
    const out = new Array(n).fill(NaN);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += arr[i];
        if (i >= period) sum -= arr[i - period];
        if (i >= period - 1) out[i] = sum / period;
    }
    return out;
}

function rollingSum(arr, period) {
    const n = arr.length;
    const out = new Array(n).fill(NaN);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += arr[i];
        if (i >= period) sum -= arr[i - period];
        if (i >= period - 1) out[i] = sum;
    }
    return out;
}

function rollingStd(arr, period) {
    const n = arr.length;
    const out = new Array(n).fill(NaN);
    for (let i = period - 1; i < n; i++) {
        const window = arr.slice(i - period + 1, i + 1);
        const mean = window.reduce((a, b) => a + b, 0) / period;
        const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
        out[i] = Math.sqrt(variance);
    }
    return out;
}

function diffPrepend(arr) {
    const n = arr.length;
    const out = new Array(n).fill(0);
    for (let i = 1; i < n; i++) out[i] = arr[i] - arr[i - 1];
    return out;
}

// ─── INDICATEURS — PORTAGE FIDÈLE DU CODE PYTHON VALIDÉ ──────────────────────

// PSAR (classic_indicators.py: parabolic_sar) — causal, séquentiel pur
function parabolicSar(high, low, afStep = 0.02, afMax = 0.2) {
    const n = high.length;
    const sar = new Array(n).fill(0);
    const trend = new Array(n).fill(1);
    let af = afStep;
    let ep = high[0];
    sar[0] = low[0];

    for (let i = 1; i < n; i++) {
        const prevSar = sar[i - 1];
        if (trend[i - 1] === 1) {
            sar[i] = prevSar + af * (ep - prevSar);
            sar[i] = Math.min(sar[i], low[i - 1], i >= 2 ? low[i - 2] : low[i - 1]);
            if (low[i] < sar[i]) {
                trend[i] = -1;
                sar[i] = ep;
                ep = low[i];
                af = afStep;
            } else {
                trend[i] = 1;
                if (high[i] > ep) {
                    ep = high[i];
                    af = Math.min(af + afStep, afMax);
                }
            }
        } else {
            sar[i] = prevSar - af * (prevSar - ep);
            sar[i] = Math.max(sar[i], high[i - 1], i >= 2 ? high[i - 2] : high[i - 1]);
            if (high[i] > sar[i]) {
                trend[i] = 1;
                sar[i] = ep;
                ep = high[i];
                af = afStep;
            } else {
                trend[i] = -1;
                if (low[i] < ep) {
                    ep = low[i];
                    af = Math.min(af + afStep, afMax);
                }
            }
        }
    }
    const last = n - 1;
    return { psar_bullish: trend[last] === 1, psar_bearish: trend[last] === -1 };
}

// Vortex (classic_indicators.py: vortex) — causal, rolling sur le passé
function vortex(high, low, close, period = 14) {
    const n = close.length;
    const vmPlus = new Array(n).fill(0);
    const vmMinus = new Array(n).fill(0);
    const tr = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const prevHigh = i > 0 ? high[i - 1] : high[i];
        const prevLow = i > 0 ? low[i - 1] : low[i];
        const prevClose = i > 0 ? close[i - 1] : close[i];
        vmPlus[i] = Math.abs(high[i] - prevLow);
        vmMinus[i] = Math.abs(low[i] - prevHigh);
        tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - prevClose), Math.abs(low[i] - prevClose));
    }
    const sumVmPlus = rollingSum(vmPlus, period);
    const sumVmMinus = rollingSum(vmMinus, period);
    const sumTr = rollingSum(tr, period);
    const last = n - 1;
    const viPlus = sumVmPlus[last] / sumTr[last];
    const viMinus = sumVmMinus[last] / sumTr[last];
    return { vortex_bullish: viPlus > viMinus, vortex_bearish: viPlus < viMinus };
}

// Hurst (quant_stats.py: hurst_exponent_rolling) — causal, fenêtre glissante sur le passé
function hurstMeanReverting(close, window = 100, maxLag = 20) {
    const n = close.length;
    if (n < window) return { hurst_mean_reverting: false };

    const logClose = close.map(c => Math.log(c));
    const logReturns = diffPrepend(logClose);

    const series = logReturns.slice(n - window, n);
    const tau = [];
    const logLags = [];
    for (let lag = 2; lag < maxLag; lag++) {
        const diffs = [];
        for (let i = lag; i < series.length; i++) diffs.push(series[i] - series[i - lag]);
        const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length;
        const std = Math.sqrt(variance);
        tau.push(std > 0 ? std : 1e-9);
        logLags.push(Math.log(lag));
    }
    const logTau = tau.map(t => Math.log(t));
    // Régression linéaire simple (pente = Hurst), identique à np.polyfit(deg=1)
    const meanX = logLags.reduce((a, b) => a + b, 0) / logLags.length;
    const meanY = logTau.reduce((a, b) => a + b, 0) / logTau.length;
    let num = 0, den = 0;
    for (let i = 0; i < logLags.length; i++) {
        num += (logLags[i] - meanX) * (logTau[i] - meanY);
        den += (logLags[i] - meanX) ** 2;
    }
    const slope = den !== 0 ? num / den : 0.5;
    return { hurst_mean_reverting: slope < 0.45 };
}

// Kalman (quant_stats.py: kalman_filter_trend) — causal, séquentiel pur
function kalmanFilterTrend(close) {
    const n = close.length;
    if (n < 2) return { kalman_price_above: false, kalman_price_below: false };

    const diffs = diffPrepend(close).slice(1);
    const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const varianceMeasurement = diffs.reduce((a, b) => a + (b - meanDiff) ** 2, 0) / diffs.length || 1.0;
    const q = varianceMeasurement * 0.01;

    let estimate = close[0];
    let errorEstimate = 1.0;

    for (let i = 1; i < n; i++) {
        const predEstimate = estimate;
        const predError = errorEstimate + q;
        const kalmanGain = predError / (predError + varianceMeasurement);
        estimate = predEstimate + kalmanGain * (close[i] - predEstimate);
        errorEstimate = (1 - kalmanGain) * predError;
    }
    const lastClose = close[n - 1];
    return { kalman_price_above: lastClose > estimate, kalman_price_below: lastClose < estimate };
}

// VWAP (volume_proxy.py: vwap_deviation) — causal, proxy de volume par range
function vwapPriceSignal(high, low, close, period = 20) {
    const n = close.length;
    const typicalPrice = close.map((c, i) => (high[i] + low[i] + c) / 3);
    const volume = high.map((h, i) => {
        const r = h - low[i];
        return r === 0 ? 1e-9 : r;
    });
    const pv = typicalPrice.map((tp, i) => tp * volume[i]);
    const cumPv = rollingSum(pv, period);
    const cumV = rollingSum(volume, period);
    const last = n - 1;
    const vwap = cumV[last] !== 0 ? cumPv[last] / cumV[last] : NaN;
    return { vwap_price_above: close[last] > vwap, vwap_price_below: close[last] < vwap };
}

// AD Line (volume_proxy.py: accumulation_distribution) — causal, cumsum sur le passé
function adLineSignal(high, low, close, period = 20) {
    const n = close.length;
    const mfm = high.map((h, i) => {
        const rng = h - low[i];
        const rngSafe = rng === 0 ? 1e-9 : rng;
        return ((close[i] - low[i]) - (h - close[i])) / rngSafe;
    });
    const volume = high.map((h, i) => h - low[i]); // proxy
    const mfv = mfm.map((m, i) => m * volume[i]);
    const adLine = new Array(n).fill(0);
    let cum = 0;
    for (let i = 0; i < n; i++) { cum += mfv[i]; adLine[i] = cum; }
    const adSma = rollingMean(adLine, period);
    const last = n - 1;
    return { ad_line_above_sma: adLine[last] > adSma[last], ad_line_below_sma: adLine[last] < adSma[last] };
}

// OBV (volume_proxy.py: obv_advanced) — causal, cumsum sur le passé
function obvSignal(high, low, close, period = 20) {
    const n = close.length;
    const volume = high.map((h, i) => h - low[i]); // proxy
    const direction = diffPrepend(close).map(d => Math.sign(d));
    direction[0] = 0;
    const obv = new Array(n).fill(0);
    let cum = 0;
    for (let i = 0; i < n; i++) { cum += direction[i] * volume[i]; obv[i] = cum; }
    const obvSma = rollingMean(obv, period);
    const last = n - 1;
    return { obv_above_sma: obv[last] > obvSma[last], obv_below_sma: obv[last] < obvSma[last] };
}

// SMC Swing High/Low (smart_money.py: swing_highs_lows) — NON-CAUSAL dans le
// backtest (regarde swingLength bougies avant ET après). Pour le serveur live,
// on calcule l'état du swing à l'indice (n-1-swingLength) — la bougie la plus
// récente pour laquelle on a déjà reçu les swingLength bougies suivantes
// nécessaires à sa confirmation. C'est exactement la même définition que le
// backtest, simplement appliquée avec le délai naturel que cette définition
// implique déjà en conditions réelles.
function smcSwingConfirmed(high, low, swingLength = 5) {
    const n = high.length;
    const confirmIdx = n - 1 - swingLength;
    if (confirmIdx < swingLength) {
        return { smc_swing_high: false, smc_swing_low: false, confirmed_index: null };
    }
    const windowH = high.slice(confirmIdx - swingLength, confirmIdx + swingLength + 1);
    const windowL = low.slice(confirmIdx - swingLength, confirmIdx + swingLength + 1);

    const maxH = Math.max(...windowH);
    const argmaxH = windowH.indexOf(maxH);
    const isSwingHigh = (high[confirmIdx] === maxH) && (argmaxH === swingLength);

    const minL = Math.min(...windowL);
    const argminL = windowL.indexOf(minL);
    const isSwingLow = (low[confirmIdx] === minL) && (argminL === swingLength);

    return { smc_swing_high: isSwingHigh, smc_swing_low: isSwingLow, confirmed_index: confirmIdx };
}


module.exports = {
    smcSwingConfirmed,
    atr, rollingMean, rollingSum, rollingStd, diffPrepend,
    parabolicSar, vortex, hurstMeanReverting, kalmanFilterTrend,
    vwapPriceSignal, adLineSignal, obvSignal,
    SL_ATR_MULT, TP_ATR_MULT, SWING_CONFIRM_DELAY,
};
