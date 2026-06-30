'use strict';
const ind = require('./indicators.js');

/*
 * Calcule TOUS les signaux nécessaires (les 14 utilisés à travers les 12
 * combos) à partir d'un tableau de bougies OHLC [{open, high, low, close}, ...]
 * triées chronologiquement (la plus récente en dernier).
 */
function computeAllSignals(candles) {
    const high = candles.map(c => c.high);
    const low = candles.map(c => c.low);
    const close = candles.map(c => c.close);

    const psar = ind.parabolicSar(high, low);
    const vtx = ind.vortex(high, low, close);
    const hurst = ind.hurstMeanReverting(close);
    const kalman = ind.kalmanFilterTrend(close);
    const vwap = ind.vwapPriceSignal(high, low, close);
    const adl = ind.adLineSignal(high, low, close);
    const obv = ind.obvSignal(high, low, close);
    const swing = ind.smcSwingConfirmed(high, low);

    return {
        ...psar, ...vtx, ...hurst, ...kalman, ...vwap, ...adl, ...obv, ...swing,
    };
}

/*
 * Vérifie si TOUS les signaux requis par un combo sont actifs (true) dans
 * l'état de signaux calculé. Retourne true/false.
 */
function comboMatches(allSignals, requiredSignalNames) {
    return requiredSignalNames.every(name => allSignals[name] === true);
}

/*
 * Calcule SL/TP en prix réel à partir de l'ATR courant, du prix d'entrée et
 * de la direction — identique à simulate_trades_for_signal (Python):
 * SL = 1.5×ATR, TP = 2.25×ATR (validé: aucun des 12 combos retenus n'utilise
 * un ratio personnalisé, voir investigation précédente).
 */
function computeSlTp(candles, direction) {
    const high = candles.map(c => c.high);
    const low = candles.map(c => c.low);
    const close = candles.map(c => c.close);
    const atrArr = ind.atr(high, low, close, 14);
    const lastAtr = atrArr[atrArr.length - 1];
    const entryPrice = close[close.length - 1];

    if (isNaN(lastAtr) || lastAtr <= 0) return null;

    let sl, tp;
    if (direction === 'BUY') {
        sl = entryPrice - ind.SL_ATR_MULT * lastAtr;
        tp = entryPrice + ind.TP_ATR_MULT * lastAtr;
    } else {
        sl = entryPrice + ind.SL_ATR_MULT * lastAtr;
        tp = entryPrice - ind.TP_ATR_MULT * lastAtr;
    }
    return { entryPrice, sl, tp, atr: lastAtr };
}

module.exports = { computeAllSignals, comboMatches, computeSlTp };
