// node tools/runpod/booking.test.mjs
import { validateBooking, cardsFor, decide, podsOf, isLive, cloudsFor, podDiskFor, hoursToCover, statusLine } from './booking.mjs';

let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const H = 3600_000;
const now = Date.parse('2026-10-21T05:00:00Z');
const wfs = [{ id: 'image_edit_krea2_quadview' }, { id: 'image_sdxl_smoke_test' }];

// ---- validation ----
const ok = validateBooking({ count: 2, minVramGb: 24, maxPricePerHr: 0.35, serve: ['image_edit_krea2_quadview'],
    startAt: '2026-10-21T06:00:00Z', readyBy: '2026-10-21T08:00:00Z', endAt: '2026-10-21T17:00:00Z' }, { now, workflows: wfs });
check('a full booking is accepted and normalised', ok.count === 2 && ok.cloud === 'community' && ok.keepHunting === true && /^Workshop 2026-10-21/.test(ok.name));
check('machines: 1 to 8', throws(() => validateBooking({ count: 9, minVramGb: 24, maxPricePerHr: 1 }, { now }), /1 to 8/) && throws(() => validateBooking({ count: 0, minVramGb: 24, maxPricePerHr: 1 }, { now }), /1 to 8/));
check('a GPU size is required', throws(() => validateBooking({ count: 1, maxPricePerHr: 1 }, { now }), /GPU size/));
check('a price cap is required', throws(() => validateBooking({ count: 1, minVramGb: 24 }, { now }), /price cap/));
check('an unknown workflow is refused', throws(() => validateBooking({ count: 1, minVramGb: 24, maxPricePerHr: 1, serve: ['nope'] }, { now, workflows: wfs }), /not in the library/));
check('shut-down before the start is refused', throws(() => validateBooking({ count: 1, minVramGb: 24, maxPricePerHr: 1, startAt: '2026-10-21T10:00:00Z', endAt: '2026-10-21T09:00:00Z' }, { now }), /after the start/));
check('a shut-down time already past is refused', throws(() => validateBooking({ count: 1, minVramGb: 24, maxPricePerHr: 1, startAt: '2026-10-20T01:00:00Z', endAt: '2026-10-20T04:00:00Z' }, { now }), /already past/));
check('ready-by before the start is refused', throws(() => validateBooking({ count: 1, minVramGb: 24, maxPricePerHr: 1, startAt: '2026-10-21T10:00:00Z', readyBy: '2026-10-21T09:00:00Z' }, { now }), /before the start/));
check('on shared storage the booking is Secure, whatever was picked', (() => { const v = validateBooking({ count: 1, minVramGb: 24, maxPricePerHr: 1, cloud: 'community', volumeId: 'uxd7q30mim' }, { now }); return v.volumeId === 'uxd7q30mim' && v.cloud === 'secure' && cloudsFor(v).join() === 'false'; })());
check('"none" means no shared storage', validateBooking({ count: 1, minVramGb: 24, maxPricePerHr: 1, volumeId: 'none' }, { now }).volumeId === null);
check('keep hunting can be switched off', validateBooking({ count: 1, minVramGb: 24, maxPricePerHr: 1, keepHunting: false }, { now }).keepHunting === false);

// ---- cards ----
const rows = [
    { id: 'A5000', vramGb: 24, pricePerHr: 0.16, fits: true, launchable: true },
    { id: '3090', vramGb: 24, pricePerHr: 0.22, fits: true, launchable: true },
    { id: '4080', vramGb: 16, pricePerHr: 0.12, fits: true, launchable: true },      // too small for 24 GB
    { id: 'A6000', vramGb: 48, pricePerHr: 0.33, fits: true, launchable: true },
    { id: '4090', vramGb: 24, pricePerHr: 0.69, fits: true, launchable: true },      // over the cap
    { id: 'MIG', vramGb: 24, pricePerHr: 0.10, fits: true, launchable: false },      // RunPod refuses it
    { id: 'L4', vramGb: 24, pricePerHr: null, fits: true, launchable: true },        // no price
];
const cards = cardsFor(rows, { minVramGb: 24, maxPricePerHr: 0.35 }).map(c => c.id);
check(`cards: at least the GPU size, at most the cap, launchable, cheapest first (${cards})`, cards.join(',') === 'A5000,3090,A6000');
check('cloud order: community, then secure when asked', cloudsFor({ cloud: 'community' }).join() === 'true' && cloudsFor({ cloud: 'community-secure' }).join() === 'true,false' && cloudsFor({ cloud: 'secure' }).join() === 'false');
check('disk with no volume: models + results, at least 40 GB', podDiskFor(19.3) === 36 + 4 && podDiskFor(44.9) === 63 && podDiskFor(1, 80) === 80);

// ---- the minute-by-minute decision ----
const b = { ...ok, id: 'x1', state: 'active' };
check('before the start: wait', decide(b, Date.parse('2026-10-21T05:59:00Z'), []).action === 'wait');
check('from the start, machines missing: launch', (() => { const d = decide(b, Date.parse('2026-10-21T06:01:00Z'), [{}]); return d.action === 'launch' && d.missing === 1; })());
check('all found: hold', decide(b, Date.parse('2026-10-21T07:00:00Z'), [{}, {}]).action === 'hold');
check('past ready-by, keep hunting on: still launch', decide(b, Date.parse('2026-10-21T09:00:00Z'), [{}]).action === 'launch');
check('past ready-by, keep hunting off: hold, late', (() => { const d = decide({ ...b, keepHunting: false }, Date.parse('2026-10-21T09:00:00Z'), [{}]); return d.action === 'hold' && d.late && d.missing === 1; })());
check('a lost machine is hunted again', decide(b, Date.parse('2026-10-21T12:00:00Z'), [{}]).action === 'launch');
check('at the end time with machines: end', decide(b, Date.parse('2026-10-21T17:00:00Z'), [{}]).action === 'end');
check('at the end time with none left: finish', decide(b, Date.parse('2026-10-21T17:00:00Z'), []).action === 'finish');
check('no end time: holds all day and night', decide({ ...b, endAt: null }, Date.parse('2026-10-22T03:00:00Z'), [{}, {}]).action === 'hold');
check('a stopped booking does nothing', decide({ ...b, state: 'stopped' }, Date.parse('2026-10-21T07:00:00Z'), []).action === 'none');

// ---- machines by name ----
const pods = [{ name: 'comfyq-bk-x1-1', desiredStatus: 'RUNNING' }, { name: 'comfyq-bk-x1-2', desiredStatus: 'EXITED' }, { name: 'comfyq-bk-x10-1', desiredStatus: 'RUNNING' }, { name: 'other', desiredStatus: 'RUNNING' }];
const mine = podsOf(b, pods);
check(`a booking's machines are found by name, and only its own (${mine.map(p => p.name)})`, mine.length === 2 && mine.filter(isLive).length === 1);

// ---- balance and status ----
check('balance must cover until the end time', Math.round(hoursToCover(b, now)) === 11);
check('with no end time, a working day', hoursToCover({ ...b, endAt: null }, now) === 10);
check('status line while hunting', /0 of 2 ready · hunting \(5 tries\)/.test(statusLine({ ...b, tries: 5 }, [], Date.parse('2026-10-21T06:30:00Z'))));
check('status line before the start', /hunting from/.test(statusLine(b, [], now)));

console.log(`booking: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
