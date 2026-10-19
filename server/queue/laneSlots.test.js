// Each served workflow (lane) has its own timeline. Found while preparing a
// 20-student load test on one card serving two workflows: "as soon as
// possible" bookings were all lined up on ONE timeline, so the second lane sat
// idle until the first lane's bookings had passed. (node server/queue/laneSlots.test.js)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobQueue } = require('./jobQueue');

const ok = [];
const check = (label, cond) => { assert.ok(cond, label); ok.push(label); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyq-laneslots-'));
const q = new JobQueue(path.join(dir, 'queue.db'));
const T = 1_000_000_000_000;
const MIN = 60_000;

// Five video jobs booked back to back on lane A.
for (let i = 0; i < 5; i++) {
    const at = q.nextFreeSlot(T, MIN, 'video');
    q.insert({ userId: `s${i}`, workflowId: 'video', scheduledAt: at });
}
check('bookings on one lane line up one after another', q.nextFreeSlot(T, MIN, 'video') === T + 5 * MIN);
check('a booking on the OTHER lane starts now, not after the first lane\'s queue', q.nextFreeSlot(T, MIN, 'image') === T);
q.insert({ userId: 'x', workflowId: 'image', scheduledAt: T });
check('the other lane then queues behind its own job only', q.nextFreeSlot(T, MIN, 'image') === T + MIN);
// The image job sits at T beside the first video job, so the whole machine's
// timeline is busy until the last video job ends.
check('without a workflow every job counts (one lane, as before)', q.nextFreeSlot(T, MIN) === T + 5 * MIN);

check('an explicit slot collides with its own lane', q.findCollisions(T, MIN, null, 'video').length === 1);
check('but not with another lane\'s job at the same time', q.findCollisions(T + MIN, MIN, null, 'image').length === 0);
check('without a workflow it collides with everything, as before', q.findCollisions(T, MIN).length === 2);
const vid = q.findCollisions(T, MIN, null, 'video')[0];
check('rescheduling a job onto its own slot is not a collision with itself', q.findCollisions(T, MIN, vid, 'video').length === 0);

q.db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`laneSlots: all ${ok.length} checks passed`);
