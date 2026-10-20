// node tools/runpod/spend.test.mjs — the spending figures the console shows.
import { emptyLedger, updateLedger, summarize, overlapHours, HOUR } from './spend.mjs';
import { thunderHourly, normalizeOffers } from './thunder.mjs';

let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// A fixed local day: 2026-10-20 08:00.
const day = new Date(2026, 9, 20, 8, 0, 0).getTime();

// ---- Thunder's price formula --------------------------------------------------
const offers = normalizeOffers({
    specs: { l40_x1: { gpuCount: 1, displayName: 'NVIDIA L40', vramGB: 48, vcpuOptions: [6, 8, 12], storageGB: { min: 100, max: 500 } } },
    pricing: { l40_x1: 0.79, additional_vcpus: 0.04, disk_gb: 0.0003 },
    status: {},
});
const l40 = offers[0];
check('the included vCPUs are the smallest option', l40.includedVcpus === 6);
check('L40 at the minimum costs the GPU price', near(thunderHourly(l40, 6, 100), 0.79));
check('L40 with 8 vCPU and 200 GB costs $0.90/h', near(thunderHourly(l40, 8, 200), 0.90));
check('disk under 100 GB is never a discount', near(thunderHourly(l40, 6, 50), 0.79));
check('an offer with no price has no hourly figure', thunderHourly({ pricePerHr: null }, 8, 200) === null);

// ---- overlap -----------------------------------------------------------------
check('overlap inside', near(overlapHours(0, 2 * HOUR, 0, 10 * HOUR), 2));
check('overlap clipped', near(overlapHours(0, 4 * HOUR, 3 * HOUR, 10 * HOUR), 1));
check('no overlap', overlapHours(0, HOUR, 2 * HOUR, 3 * HOUR) === 0);

// ---- Thunder sessions --------------------------------------------------------
let l = emptyLedger();
l = updateLedger(l, { now: day, thunderLive: [{ uuid: 'aa', name: 'x', gpu: 'L40', ratePerHr: 0.9, start: day - HOUR }], runpodBalance: null });
let s = summarize(l, { now: day });
check('a running instance counts its time so far today', near(s.today, 0.9));
check('its rate is the current rate', near(s.ratePerHr, 0.9));
check('it is listed as a running machine', s.machines.length === 1 && near(s.machines[0].costSoFar, 0.9));
// Deleted: no longer listed half an hour later.
l = updateLedger(l, { now: day + HOUR / 2, thunderLive: [], runpodBalance: null });
s = summarize(l, { now: day + 5 * HOUR });
check('a deleted instance stops adding up', near(s.today, 0.9 * 1.5));
check('and is no longer running', s.machines.length === 0 && s.ratePerHr === 0);
// Thunder unreadable: sessions stay as they were (not closed by mistake).
let l2 = updateLedger(emptyLedger(), { now: day, thunderLive: [{ uuid: 'bb', ratePerHr: 1, start: day }], runpodBalance: null });
l2 = updateLedger(l2, { now: day + HOUR, thunderLive: null, runpodBalance: null });
check('an unreadable Thunder leaves the instance open', l2.thunder.bb.end === null);
// An instance started yesterday only counts today's part in "today".
let l3 = updateLedger(emptyLedger(), { now: day, thunderLive: [{ uuid: 'cc', ratePerHr: 1, start: day - 10 * HOUR }], runpodBalance: null });
s = summarize(l3, { now: day });
check('yesterday\'s hours are not today\'s', near(s.today, 8));
check('but they are this month\'s', near(s.month, 10));

// ---- RunPod balance ----------------------------------------------------------
let r = updateLedger(emptyLedger(), { now: day, thunderLive: [], runpodBalance: 10 });
r = updateLedger(r, { now: day + HOUR, thunderLive: [], runpodBalance: 9.5 });
s = summarize(r, { now: day + HOUR, runpodBalance: 9.5, runpodRatePerHr: 0.5 });
check('RunPod spend today = balance drop', near(s.runpod.today, 0.5));
check('hours left at the current rate', s.runpod.hoursLeft === 19);
// A top-up must not read as negative spend or hide what was spent.
r = updateLedger(r, { now: day + 2 * HOUR, thunderLive: [], runpodBalance: 29.5 });
r = updateLedger(r, { now: day + 3 * HOUR, thunderLive: [], runpodBalance: 29.0 });
s = summarize(r, { now: day + 3 * HOUR, runpodBalance: 29.0, runpodRatePerHr: 0.5 });
check('a top-up is not counted as spending', near(s.runpod.today, 1.0));
// A new day starts from the balance at its first reading.
const tomorrow = day + 24 * HOUR;
r = updateLedger(r, { now: tomorrow, thunderLive: [], runpodBalance: 28 });
s = summarize(r, { now: tomorrow, runpodBalance: 28 });
check('a new day starts at zero', s.runpod.today === 0);
check('the month keeps counting', near(s.runpod.month, 2.0));

// ---- totals ------------------------------------------------------------------
let t = updateLedger(emptyLedger(), { now: day, thunderLive: [{ uuid: 'dd', ratePerHr: 1, start: day }], runpodBalance: 5 });
s = summarize(t, { now: day, runpodBalance: 5, runpodRatePerHr: 0.25, budgetPerDay: 10 });
check('the rate adds both providers', near(s.ratePerHr, 1.25));
check('projected to midnight = today + rate × hours left', near(s.projectedToday, 1.25 * 16));
check('the budget is passed through', s.budgetPerDay === 10);

console.log(`spend: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
