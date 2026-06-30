'use strict';
const fetch = require('node-fetch');

const FIREBASE_URL = process.env.FIREBASE_URL || 'https://forex-trading-bendo-default-rtdb.firebaseio.com';
const FIREBASE_PATH = 'mega'; // /mega.json — cohérent avec /prod.json, /ultimate.json, /ramce.json

/*
 * Encode une paire (ex: "EUR/USD") en clé Firebase valide ("EUR_USD") —
 * Firebase interdit les "/" dans les clés, même règle que sur tes autres outils.
 */
function encodePairKey(pair) {
    return pair.replace(/\//g, '_');
}

async function logSignal(signalData) {
    const url = `${FIREBASE_URL}/${FIREBASE_PATH}/signals.json`;
    const payload = {
        ...signalData,
        pair: encodePairKey(signalData.pair),
        timestamp: Date.now(),
    };
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return await res.json();
    } catch (e) {
        console.error('Erreur log Firebase:', e.message);
        return null;
    }
}

async function getLastSignalTime(pair, direction) {
    const key = `${encodePairKey(pair)}_${direction}`;
    const url = `${FIREBASE_URL}/${FIREBASE_PATH}/lastSignalTime/${key}.json`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        return data || null;
    } catch (e) {
        console.error('Erreur lecture lastSignalTime:', e.message);
        return null;
    }
}

async function setLastSignalTime(pair, direction, timestamp) {
    const key = `${encodePairKey(pair)}_${direction}`;
    const url = `${FIREBASE_URL}/${FIREBASE_PATH}/lastSignalTime/${key}.json`;
    try {
        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(timestamp),
        });
    } catch (e) {
        console.error('Erreur écriture lastSignalTime:', e.message);
    }
}

module.exports = { logSignal, getLastSignalTime, setLastSignalTime, encodePairKey, FIREBASE_URL, FIREBASE_PATH };
