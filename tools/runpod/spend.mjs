// What the owner is spending, right now and so far, across RunPod and Thunder.
//
// The two providers give very different things to work with:
//  - RunPod reports money: the account balance and the current $/h
//    (GraphQL `myself { clientBalance currentSpendPerHr }`). Spent today is the
//    balance at the first reading of the day minus the balance now, plus any
//    top-up seen in between — real money, not an estimate of it.
//  - Thunder has no balance or usage API (only /v1/user-data, a subscription
//    status). Its spend is computed: each instance's hourly price (Thunder's
//    own formula, thunderHourly) times how long it has existed. A ledger
//    remembers instances after they are deleted, so today's and this month's
//    totals keep them. An instance deleted while the console was closed is
//    closed at the first reading that misses it, so it can read a little high —
//    the safe direction for a spending figure.
//
// Pure functions: the console route fetches, these decide. Tested in spend.test.mjs.

export const HOUR = 3600_000;

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monthKey = (t) => dayKey(t).slice(0, 7);
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfMonth = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); };

export function emptyLedger() {
    return { thunder: {}, runpod: { day: null, month: null, last: null } };
}

/** Hours of [start, end) that fall inside [from, to). */
export function overlapHours(start, end, from, to) {
    const a = Math.max(start, from), b = Math.min(end, to);
    return b > a ? (b - a) / HOUR : 0;
}

/**
 * Fold one reading into the ledger.
 * @param {object} ledger
 * @param {object} r
 * @param {number} r.now
 * @param {Array<{uuid,name,gpu,ratePerHr,start}>|null} r.thunderLive  null = could not read Thunder (keep sessions open)
 * @param {number|null} r.runpodBalance                                  null = could not read RunPod
 */
export function updateLedger(ledger, { now, thunderLive, runpodBalance }) {
    const l = ledger && ledger.thunder && ledger.runpod ? ledger : emptyLedger();
    if (Array.isArray(thunderLive)) {
        const live = new Set();
        for (const i of thunderLive) {
            live.add(i.uuid);
            const s = l.thunder[i.uuid] || (l.thunder[i.uuid] = { uuid: i.uuid, start: i.start || now, end: null });
            s.name = i.name || s.name || i.uuid;
            s.gpu = i.gpu || s.gpu || null;
            if (i.ratePerHr != null) s.ratePerHr = i.ratePerHr;
            s.end = null; // listed again: still billing
        }
        for (const s of Object.values(l.thunder)) if (!live.has(s.uuid) && s.end == null) s.end = now;
        // Keep a little over a month of closed sessions.
        const keepFrom = startOfMonth(now) - 35 * 24 * HOUR;
        for (const [k, s] of Object.entries(l.thunder)) if (s.end != null && s.end < keepFrom) delete l.thunder[k];
    }
    if (typeof runpodBalance === 'number' && Number.isFinite(runpodBalance)) {
        const rp = l.runpod;
        // A rise in the balance is a top-up: count it so spend = start - now + topUps.
        const rise = rp.last && runpodBalance > rp.last.balance + 0.005 ? runpodBalance - rp.last.balance : 0;
        if (!rp.day || rp.day.key !== dayKey(now)) rp.day = { key: dayKey(now), balance: runpodBalance, topUps: 0, since: now };
        else rp.day.topUps += rise;
        if (!rp.month || rp.month.key !== monthKey(now)) rp.month = { key: monthKey(now), balance: runpodBalance, topUps: 0, since: now };
        else rp.month.topUps += rise;
        rp.last = { at: now, balance: runpodBalance };
    }
    return l;
}

/** The totals the console shows. */
export function summarize(ledger, { now, runpodRatePerHr = null, runpodBalance = null, runpodMachines = [], budgetPerDay = null }) {
    const l = ledger || emptyLedger();
    const dayFrom = startOfDay(now), monthFrom = startOfMonth(now);
    const sessions = Object.values(l.thunder);
    const cost = (s, from) => (s.ratePerHr || 0) * overlapHours(s.start, s.end ?? now, from, now);
    const thunderToday = sessions.reduce((a, s) => a + cost(s, dayFrom), 0);
    const thunderMonth = sessions.reduce((a, s) => a + cost(s, monthFrom), 0);
    const thunderRate = sessions.filter(s => s.end == null).reduce((a, s) => a + (s.ratePerHr || 0), 0);

    const spentSince = (base) => base && typeof runpodBalance === 'number'
        ? Math.max(0, base.balance - runpodBalance + (base.topUps || 0)) : null;
    const runpodToday = spentSince(l.runpod.day);
    const runpodMonth = spentSince(l.runpod.month);
    const rpRate = typeof runpodRatePerHr === 'number' ? runpodRatePerHr : 0;

    const machines = [
        ...sessions.filter(s => s.end == null).map(s => ({
            provider: 'thunder', id: s.uuid, name: s.name, gpu: s.gpu, ratePerHr: s.ratePerHr ?? null,
            since: s.start, costSoFar: +((s.ratePerHr || 0) * (now - s.start) / HOUR).toFixed(4),
        })),
        ...runpodMachines.map(m => ({
            provider: 'runpod', ...m,
            costSoFar: m.since && m.ratePerHr ? +(m.ratePerHr * (now - m.since) / HOUR).toFixed(4) : null,
        })),
    ];
    const ratePerHr = +(rpRate + thunderRate).toFixed(4);
    const today = +((runpodToday || 0) + thunderToday).toFixed(4);
    return {
        at: now,
        ratePerHr,
        today,
        month: +((runpodMonth || 0) + thunderMonth).toFixed(4),
        budgetPerDay,
        // What today will reach if everything keeps running until midnight.
        projectedToday: +(today + ratePerHr * Math.max(0, startOfDay(now) + 24 * HOUR - now) / HOUR).toFixed(4),
        machines,
        runpod: {
            balance: runpodBalance, ratePerHr: runpodRatePerHr,
            today: runpodToday, month: runpodMonth,
            countingSince: { today: l.runpod.day?.since ?? null, month: l.runpod.month?.since ?? null },
            hoursLeft: typeof runpodBalance === 'number' && rpRate > 0 ? +(runpodBalance / rpRate).toFixed(1) : null,
        },
        thunder: { ratePerHr: +thunderRate.toFixed(4), today: +thunderToday.toFixed(4), month: +thunderMonth.toFixed(4) },
    };
}
