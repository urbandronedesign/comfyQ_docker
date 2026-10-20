// What the app warns about, decided from what the console reports. Pure: the
// main process fetches, this decides, so every rule is tested (watch.test.js).
//
// Warnings, each said once (re-armed only when the cause goes away and comes back):
//   - a machine finished its setup and serves, or its setup failed (it bills anyway);
//   - a machine has been on for 3 hours, then again at 6 and 9;
//   - today passed the daily budget;
//   - a balance covers less than 4 hours at the current rate.
// What is already true when the app starts is taken as known, not announced:
// opening the app must not fire a burst of old news.
'use strict';

const HOUR = 3600_000;
const LONG_ON_HOURS = [3, 6, 9];
const LOW_BALANCE_HOURS = 4;

const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const dayKey = (t) => new Date(t).toDateString();

/**
 * @param {object|null} state  what was decided last time (null on the first call)
 * @param {object} snap
 * @param {object} snap.spend      GET /api/spend
 * @param {Array<{id,name,provider,stage,detail}>} snap.machines  stage: 'setting-up' | 'serving' | 'failed' | 'other'
 * @param {number} now
 * @returns {{ state: object, events: Array<{key,title,body,level}> }}
 */
function decide(state, { spend, machines = [] }, now) {
    const first = !state;
    const s = state ? JSON.parse(JSON.stringify(state)) : { stages: {}, longOn: {}, budgetDay: null, low: {} };
    const events = [];
    const say = (key, title, body, level = 'info') => { if (!first) events.push({ key, title, body, level }); };

    // ---- setup finished / failed ----
    const seen = new Set();
    for (const m of machines) {
        seen.add(m.id);
        const before = s.stages[m.id];
        if (before !== m.stage) {
            const label = `${m.provider === 'thunder' ? 'Thunder' : 'RunPod'} · ${m.name || m.id}`;
            if (m.stage === 'serving') say(`serving:${m.id}`, /admin mode/.test(m.name || '') ? `${label} is up` : `${label} is serving`,
                /admin mode/.test(m.name || '') ? 'ComfyQ answers in admin mode: pick a workflow in its admin panel.' : 'The student pages are ready.');
            if (m.stage === 'failed') say(`failed:${m.id}`, `${label}: setup failed`, `${m.detail || 'Open the console to see why.'} It is still billing.`, 'bad');
        }
        s.stages[m.id] = m.stage;
    }
    for (const id of Object.keys(s.stages)) if (!seen.has(id)) delete s.stages[id];

    // ---- on for a long time ----
    const running = spend?.machines || [];
    const on = new Set();
    for (const m of running) {
        const id = `${m.provider}:${m.id}`;
        on.add(id);
        const hours = m.since ? (now - m.since) / HOUR : 0;
        const reached = LONG_ON_HOURS.filter(h => hours >= h).pop() || 0;
        const told = s.longOn[id] || 0;
        if (reached > told) {
            const label = `${m.provider === 'thunder' ? 'Thunder' : 'RunPod'} · ${m.name || m.id}`;
            say(`long:${id}:${reached}`, `${label} has been on for ${reached} hours`,
                `${money(m.costSoFar ?? (m.ratePerHr || 0) * hours)} so far at ${money(m.ratePerHr)}/h. Delete or stop it if the class is over.`, 'warn');
        }
        s.longOn[id] = Math.max(told, reached);
    }
    for (const id of Object.keys(s.longOn)) if (!on.has(id)) delete s.longOn[id];

    // ---- daily budget ----
    const budget = spend?.budgetPerDay;
    if (budget && spend.today >= budget) {
        if (s.budgetDay !== dayKey(now)) say(`budget:${dayKey(now)}`, 'Daily budget passed', `Today is at ${money(spend.today)}, over the ${money(budget)} budget, and ${money(spend.ratePerHr)}/h is still running.`, 'bad');
        s.budgetDay = dayKey(now);
    }

    // ---- balances running out ----
    for (const [name, b] of [['RunPod', spend?.runpod], ['Thunder', spend?.thunder]]) {
        const low = b && b.hoursLeft != null && b.ratePerHr > 0 && b.hoursLeft < LOW_BALANCE_HOURS;
        if (low && !s.low[name]) say(`low:${name}`, `${name} balance is running out`, `About ${money(b.balance)} left: ${b.hoursLeft} hours at the current rate.${name === 'RunPod' ? ' RunPod stops a Pod when it reaches zero.' : ''}`, 'bad');
        s.low[name] = !!low;
    }
    return { state: s, events };
}

/** The question asked before quitting, or null when nothing bills by the hour. */
function quitQuestion(spend) {
    const ms = spend?.machines || [];
    if (!ms.length) return null;
    const rate = ms.reduce((a, m) => a + (Number(m.ratePerHr) || 0), 0);
    return {
        title: `${ms.length} machine${ms.length > 1 ? 's are' : ' is'} still billing`,
        detail: `${ms.map(m => `• ${m.provider === 'thunder' ? 'Thunder' : 'RunPod'} · ${m.name || m.id}: ${money(m.ratePerHr)}/h`).join('\n')}\n\n`
            + `Together ${money(rate)}/h. Quitting the app does not stop them: they keep billing, and the app will not warn you any more. `
            + 'Delete or stop them in the console first, or quit anyway.',
    };
}

/** One line for the tray tooltip. */
function trayLine(spend) {
    if (!spend) return 'ComfyQ Console';
    const ms = spend.machines || [];
    return `ComfyQ Console — ${money(spend.ratePerHr)}/h`
        + (ms.length ? ` · ${ms.length} machine${ms.length > 1 ? 's' : ''} on` : ' · nothing running')
        + ` · today ${money(spend.today)}`;
}

module.exports = { decide, quitQuestion, trayLine, LONG_ON_HOURS, LOW_BALANCE_HOURS };
