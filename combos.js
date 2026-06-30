'use strict';

// ─── CONFIGURATION DES 12 COMBOS (16 - 2 paires retirées pour quota API) ──────
// EUR/GBP et NZD/USD retirées: PF moyen le plus faible après spread IG (1.96 et 2.37)
// Source: MegaExplorer, run complet 3 ans, 8 paires x 6 timeframes, Approche B (XGBoost)
const COMBOS = [
    { pair: 'EUR/USD', direction: 'BUY',  timeframe: 'H1',  signals: ['psar_bearish', 'smc_swing_low', 'hurst_mean_reverting'] },
    { pair: 'EUR/USD', direction: 'SELL', timeframe: 'M15', signals: ['smc_swing_high', 'kalman_price_above', 'vwap_price_above', 'obv_above_sma'] },
    { pair: 'GBP/USD', direction: 'BUY',  timeframe: 'M15', signals: ['psar_bearish', 'smc_swing_low', 'kalman_price_below', 'vwap_price_below'] },
    { pair: 'GBP/USD', direction: 'SELL', timeframe: 'M30', signals: ['smc_swing_high', 'kalman_price_above'] },
    { pair: 'USD/JPY', direction: 'BUY',  timeframe: 'M15', signals: ['smc_swing_low', 'hurst_mean_reverting', 'ad_line_below_sma'] },
    { pair: 'USD/JPY', direction: 'SELL', timeframe: 'M15', signals: ['vortex_bullish', 'smc_swing_high', 'kalman_price_above', 'vwap_price_above'] },
    { pair: 'USD/CHF', direction: 'BUY',  timeframe: 'M30', signals: ['smc_swing_low', 'kalman_price_below'] },
    { pair: 'USD/CHF', direction: 'SELL', timeframe: 'H1',  signals: ['psar_bullish', 'smc_swing_high', 'hurst_mean_reverting'] },
    { pair: 'AUD/USD', direction: 'BUY',  timeframe: 'M15', signals: ['smc_swing_low', 'kalman_price_below', 'vwap_price_below', 'obv_below_sma'] },
    { pair: 'AUD/USD', direction: 'SELL', timeframe: 'M15', signals: ['smc_swing_high', 'kalman_price_above', 'vwap_price_above', 'obv_above_sma'] },
    { pair: 'USD/CAD', direction: 'BUY',  timeframe: 'H1',  signals: ['psar_bearish', 'smc_swing_low'] },
    { pair: 'USD/CAD', direction: 'SELL', timeframe: 'M15', signals: ['smc_swing_high', 'kalman_price_above', 'vwap_price_above', 'ad_line_above_sma'] },
];

const PAIRS = [...new Set(COMBOS.map(c => c.pair))];

// Twelve Data: intervalle attendu par leur API pour chaque timeframe
const TF_TO_INTERVAL = { M15: '15min', M30: '30min', H1: '1h' };

// Pour chaque paire, quels timeframes Twelve Data faut-il récupérer (dédupliqué)
const PAIR_TIMEFRAMES = {};
for (const c of COMBOS) {
    if (!PAIR_TIMEFRAMES[c.pair]) PAIR_TIMEFRAMES[c.pair] = new Set();
    PAIR_TIMEFRAMES[c.pair].add(c.timeframe);
}

module.exports = { COMBOS, PAIRS, TF_TO_INTERVAL, PAIR_TIMEFRAMES };
