// node console-app/test/watch.test.js — the app's warnings, rule by rule.
'use strict';
const { decide, quitQuestion, trayLine } = require('../watch');

let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };
const H = 3600_000;
const t0 = new Date(2026, 9, 20, 9, 0, 0).getTime();
const spend = (o = {}) => ({ ratePerHr: 0, today: 0, budgetPerDay: null, machines: [], runpod: { balance: 8, ratePerHr: 0.01, hoursLeft: 800 }, thunder: { balance: null, hoursLeft: null, ratePerHr: 0 }, ...o });
const keys = (r) => r.events.map(e => e.key.split(':')[0]);

// ---- first call: what is already true is not announced ----
let r = decide(null, { spend: spend({ machines: [{ provider: 'thunder', id: 'a', name: 'x', since: t0 - 5 * H, ratePerHr: 0.9 }] }), machines: [{ id: 'a', provider: 'thunder', stage: 'serving' }] }, t0);
check('the first reading announces nothing (already serving, already on 5 h)', r.events.length === 0);
r = decide(r.state, { spend: spend({ machines: [{ provider: 'thunder', id: 'a', name: 'x', since: t0 - 5 * H, ratePerHr: 0.9 }] }), machines: [{ id: 'a', provider: 'thunder', stage: 'serving' }] }, t0 + 60_000);
check('nothing new, nothing said', r.events.length === 0);
r = decide(r.state, { spend: spend({ machines: [{ provider: 'thunder', id: 'a', name: 'x', since: t0 - 5 * H, ratePerHr: 0.9 }] }), machines: [{ id: 'a', provider: 'thunder', stage: 'serving' }] }, t0 + 1.2 * H);
check('passing 6 hours on is said once', keys(r).join() === 'long' && /6 hours/.test(r.events[0].title));

// ---- a launch: setting up, then serving ----
let st = decide(null, { spend: spend(), machines: [] }, t0).state;
r = decide(st, { spend: spend(), machines: [{ id: 'b', provider: 'runpod', name: 'pod', stage: 'setting-up' }] }, t0);
check('a new machine setting up is not announced', r.events.length === 0);
r = decide(r.state, { spend: spend(), machines: [{ id: 'b', provider: 'runpod', name: 'pod', stage: 'serving' }] }, t0 + 10 * 60_000);
check('it starts serving: said', keys(r).join() === 'serving' && /RunPod · pod is serving/.test(r.events[0].title));
r = decide(r.state, { spend: spend(), machines: [{ id: 'b', provider: 'runpod', name: 'pod', stage: 'serving' }] }, t0 + 11 * 60_000);
check('still serving: not said again', r.events.length === 0);

// ---- setup failed ----
r = decide(r.state, { spend: spend(), machines: [{ id: 'c', provider: 'thunder', name: 'inst', stage: 'setting-up' }] }, t0);
r = decide(r.state, { spend: spend(), machines: [{ id: 'c', provider: 'thunder', name: 'inst', stage: 'failed', detail: 'rsync exited 23.' }] }, t0 + 60_000);
check('a failed setup is said, with the reason, and that it still bills', keys(r).join() === 'failed' && /rsync exited 23/.test(r.events[0].body) && /still billing/.test(r.events[0].body) && r.events[0].level === 'bad');

// ---- 3 hours on ----
st = decide(null, { spend: spend(), machines: [] }, t0).state;
const on = (h) => spend({ ratePerHr: 0.9, machines: [{ provider: 'thunder', id: 'd', name: 'class', since: t0, ratePerHr: 0.9, costSoFar: 0.9 * h }] });
r = decide(st, { spend: on(2.9) }, t0 + 2.9 * H);
check('under 3 hours: nothing', r.events.length === 0);
r = decide(r.state, { spend: on(3.1) }, t0 + 3.1 * H);
check('at 3 hours: said once, with the cost so far', keys(r).join() === 'long' && /3 hours/.test(r.events[0].title) && /\$2\.79 so far/.test(r.events[0].body));
r = decide(r.state, { spend: on(3.5) }, t0 + 3.5 * H);
check('not again before 6 hours', r.events.length === 0);
r = decide(r.state, { spend: spend() }, t0 + 4 * H);
r = decide(r.state, { spend: on(3.2) }, t0 + 3.2 * H);
check('deleted and on again: the count starts over', keys(r).join() === 'long');

// ---- budget ----
st = decide(null, { spend: spend({ budgetPerDay: 5, today: 4 }) }, t0).state;
r = decide(st, { spend: spend({ budgetPerDay: 5, today: 5.1, ratePerHr: 0.9 }) }, t0 + H);
check('passing the daily budget is said', keys(r).join() === 'budget' && r.events[0].level === 'bad');
r = decide(r.state, { spend: spend({ budgetPerDay: 5, today: 5.4, ratePerHr: 0.9 }) }, t0 + 2 * H);
check('only once that day', r.events.length === 0);
r = decide(r.state, { spend: spend({ budgetPerDay: 5, today: 5.2, ratePerHr: 0.9 }) }, t0 + 24 * H);
check('and again the next day', keys(r).join() === 'budget');
check('no budget, no warning', decide(st, { spend: spend({ today: 99 }) }, t0).events.length === 0);

// ---- balances ----
st = decide(null, { spend: spend() }, t0).state;
r = decide(st, { spend: spend({ runpod: { balance: 2, ratePerHr: 0.72, hoursLeft: 2.8 } }) }, t0);
check('RunPod under 4 hours: said, with the stop at zero', keys(r).join() === 'low' && /RunPod stops a Pod/.test(r.events[0].body));
r = decide(r.state, { spend: spend({ runpod: { balance: 1.9, ratePerHr: 0.72, hoursLeft: 2.6 } }) }, t0 + 60_000);
check('not repeated while still low', r.events.length === 0);
r = decide(r.state, { spend: spend({ runpod: { balance: 20, ratePerHr: 0.72, hoursLeft: 27 } }) }, t0 + H);
r = decide(r.state, { spend: spend({ runpod: { balance: 2, ratePerHr: 0.72, hoursLeft: 2.8 } }) }, t0 + 2 * H);
check('topped up, then low again: said again', keys(r).join() === 'low');
check('a balance with nothing running is not "running out"', decide(st, { spend: spend({ thunder: { balance: 0.5, ratePerHr: 0, hoursLeft: null } }) }, t0).events.length === 0);
r = decide(st, { spend: spend({ thunder: { balance: 1, ratePerHr: 0.9, hoursLeft: 1.1 } }) }, t0);
check('Thunder low: said too, without the RunPod line', keys(r).join() === 'low' && !/RunPod/.test(r.events[0].body));

// ---- quitting ----
check('nothing billing: quit without asking', quitQuestion(spend()) === null);
const q = quitQuestion(spend({ machines: [{ provider: 'thunder', id: 'e', name: 'class', ratePerHr: 0.9 }, { provider: 'runpod', id: 'f', name: 'pod', ratePerHr: 0.72 }] }));
check('billing: the question names each machine, the total, and that they keep billing',
    /2 machines are still billing/.test(q.title) && /Thunder · class: \$0\.90\/h/.test(q.detail) && /\$1\.62\/h/.test(q.detail) && /keep billing/.test(q.detail));

// ---- tray ----
check('tray line', trayLine(spend({ ratePerHr: 0.91, today: 2.5, machines: [{}] })) === 'ComfyQ Console — $0.91/h · 1 machine on · today $2.50');
check('tray line before the first reading', trayLine(null) === 'ComfyQ Console');

// ---- workshop bookings ----
{
    const { huntingBookings } = require('../watch');
    const bk = (events, state = 'active') => [{ id: 'k1', name: 'Workshop', state, status: 'Workshop: 1 of 2 ready · hunting', events }];
    let w = decide(null, { spend: spend(), bookings: bk([{ at: 1, kind: 'found', title: 'Workshop: machine 1 found' }]) }, t0);
    check('booking events already there when the app starts are not announced', w.events.length === 0);
    w = decide(w.state, { spend: spend(), bookings: bk([{ at: 1, kind: 'found', title: 'old' }, { at: 2, kind: 'found', title: 'Workshop: machine 2 found', body: 'RTX 3090 at $0.22/h' }]) }, t0 + 60_000);
    check('a new booking event is announced once', w.events.length === 1 && /machine 2 found/.test(w.events[0].title) && /3090/.test(w.events[0].body));
    w = decide(w.state, { spend: spend(), bookings: bk([{ at: 1, kind: 'found', title: 'old' }, { at: 2, kind: 'found', title: 'x' }]) }, t0 + 120_000);
    check('and not again', w.events.length === 0);
    w = decide(w.state, { spend: spend(), bookings: [...bk([{ at: 2, kind: 'found', title: 'x' }]), { id: 'k2', name: 'New', state: 'active', events: [{ at: 5, kind: 'created', title: 'New: booked' }, { at: 6, kind: 'found', title: 'New: machine 1 found' }] }] }, t0 + 180_000);
    check('a booking made while the app runs: its first machine is announced, "booked" is not', w.events.length === 1 && /New: machine 1 found/.test(w.events[0].title));
    w = decide(w.state, { spend: spend(), bookings: bk([{ at: 3, kind: 'blocked', title: 'Workshop: not hunting — balance too low', level: 'bad' }]) }, t0 + 240_000);
    check('a blocked hunt is announced as bad news', w.events.length === 1 && w.events[0].level === 'bad');
    const q = quitQuestion(spend(), bk([]));
    check('quitting with a booking hunting (and nothing billing) asks first', !!q && /hunt runs inside this app/.test(q.detail));
    check('a stopped booking does not hold quitting', quitQuestion(spend(), bk([], 'stopped')) === null && huntingBookings(bk([], 'ended')).length === 0);
}

// ---- Vast.ai: serving, a new https address, the credit ----
{
    const vm = (address, stage = 'serving') => [{ provider: 'vast', id: '57061526', name: 'image_edit_flux3_klein_distilled_image_edit', stage, address }];
    let v = decide(null, { spend: spend(), machines: vm('https://old-words.trycloudflare.com') }, t0);
    check('a Vast.ai machine already serving at app start is not announced', v.events.length === 0);
    v = decide(v.state, { spend: spend(), machines: vm('https://old-words.trycloudflare.com') }, t0 + 30_000);
    check('the same address again: nothing', v.events.length === 0);
    v = decide(v.state, { spend: spend(), machines: vm('https://new-words.trycloudflare.com') }, t0 + 60_000);
    check(`the address changed: one warning naming the new student page (${v.events.map(e => e.title)})`,
        keys(v).join() === 'address' && v.events[0].level === 'warn' && /Vast\.ai/.test(v.events[0].title) && /new-words\.trycloudflare\.com/.test(v.events[0].body) && /old student links no longer work/.test(v.events[0].body));
    v = decide(v.state, { spend: spend(), machines: vm('https://new-words.trycloudflare.com') }, t0 + 90_000);
    check('and only once', v.events.length === 0);
    v = decide(v.state, { spend: spend(), machines: vm(null, 'setting-up') }, t0 + 120_000);
    v = decide(v.state, { spend: spend(), machines: vm('https://new-words.trycloudflare.com') }, t0 + 150_000);
    check('a moment with no address (tunnel restarting) then the same one back: no false alarm', !keys(v).includes('address'));
    let f = decide(null, { spend: spend(), machines: vm(null, 'setting-up') }, t0);
    f = decide(f.state, { spend: spend(), machines: vm('https://a.trycloudflare.com') }, t0 + 30_000);
    check('a Vast.ai machine that starts serving is announced as such', keys(f).join() === 'serving' && /^Vast\.ai · /.test(f.events[0].title));
    const low = decide(st, { spend: spend({ vast: { balance: 0.9, ratePerHr: 0.36, hoursLeft: 2.5 } }) }, t0);
    check('Vast.ai credit running out is said', keys(low).join() === 'low' && /Vast\.ai/.test(low.events[0].title));
    const q2 = quitQuestion(spend({ machines: [{ provider: 'vast', id: 'v', name: 'flux', ratePerHr: 0.36 }] }));
    check('the quit question names a Vast.ai machine', /Vast\.ai · flux: \$0\.36\/h/.test(q2.detail));
}

// ---- My machines: the owner's own PCs, offline and back ----
{
    const hm = (stage) => [{ provider: 'home', id: 'atelier-4090', name: 'atelier-4090', stage }];
    let h = decide(null, { spend: spend(), machines: hm('offline') }, t0);
    check('a machine already offline at app start is not announced', h.events.length === 0);
    h = decide(h.state, { spend: spend(), machines: hm('serving') }, t0 + 30_000);
    check(`it comes back serving: "is back", saying the links work (${h.events.map(e => e.title)})`,
        keys(h).join() === 'back' && /^My machine · atelier-4090 is back$/.test(h.events[0].title) && /student links work/.test(h.events[0].body));
    h = decide(h.state, { spend: spend(), machines: hm('serving') }, t0 + 60_000);
    check('still serving: nothing', h.events.length === 0);
    h = decide(h.state, { spend: spend(), machines: hm('offline') }, t0 + 90_000);
    check('it stops answering: one alert, never "still billing"', keys(h).join() === 'offline' && h.events[0].level === 'bad'
        && /is offline/.test(h.events[0].title) && /Serve-ComfyQ\.bat/.test(h.events[0].body) && !/billing/.test(h.events[0].body));
    h = decide(h.state, { spend: spend(), machines: hm('offline') }, t0 + 120_000);
    check('and only once', h.events.length === 0);
    h = decide(h.state, { spend: spend(), machines: hm('other') }, t0 + 150_000);
    check('back in admin mode says to pick a workflow', keys(h).join() === 'back' && /admin panel/.test(h.events[0].body));
    let fresh = decide(null, { spend: spend(), machines: [] }, t0);
    fresh = decide(fresh.state, { spend: spend(), machines: hm('offline') }, t0 + 30_000);
    check('a machine just added while switched off is not called "offline" (it was never seen up)', fresh.events.length === 0);
    fresh = decide(fresh.state, { spend: spend(), machines: hm('serving') }, t0 + 60_000);
    check('then switched on: "is back"', keys(fresh).join() === 'back');
    const sv = decide(decide(null, { spend: spend(), machines: [] }, t0).state, { spend: spend(), machines: hm('serving') }, t0 + 30_000);
    check('a serving machine added to the list is not announced as "setup finished"', sv.events.length === 0);
}

console.log(`watch: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
