'use strict';
const fetch = require('node-fetch');

const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY || 'd3fa411da64b4e21b9c4314272a7df73';
const TF_TO_INTERVAL = { M15: '15min', M30: '30min', H1: '1h' };

/*
 * Récupère les N dernières bougies CLOSED pour une paire/timeframe.
 * outputsize=150: largement suffisant pour tous les indicateurs (le plus
 * gourmand, hurst_exponent_rolling, a besoin de 100 bougies).
 */
async function fetchCandles(pair, timeframe, outputsize = 150) {
    const interval = TF_TO_INTERVAL[timeframe];
    if (!interval) throw new Error(`Timeframe inconnu: ${timeframe}`);

    const symbol = pair; // Twelve Data accepte le format "EUR/USD" directement
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_KEY}&format=JSON`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status === 'error' || !data.values) {
        throw new Error(`Twelve Data erreur pour ${pair} ${timeframe}: ${data.message || JSON.stringify(data)}`);
    }

    // Twelve Data renvoie du plus récent au plus ancien -> on inverse pour
    // avoir l'ordre chronologique attendu par les indicateurs (le plus
    // récent en dernier, comme dans le backtest Python).
    const candles = data.values
        .map(v => ({
            datetime: v.datetime,
            open: parseFloat(v.open),
            high: parseFloat(v.high),
            low: parseFloat(v.low),
            close: parseFloat(v.close),
        }))
        .reverse();

    return candles;
}

module.exports = { fetchCandles, TF_TO_INTERVAL, TWELVE_KEY };
