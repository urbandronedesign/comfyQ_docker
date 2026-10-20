// Workshop bookings: from a start time, hunt RunPod for N machines that meet a
// GPU size and a price cap, keep every one found, replace one that is lost, and
// at an optional end time save the results and terminate them. The owner sets
// it up in the console; the console's server runs it every minute (server.mjs
// tickBookings), so it works with the app's window closed.
//
// Pure: the server fetches and launches, this validates and decides, so every
// rule is tested (booking.test.mjs).

export const BOOKING_PREFIX = 'comfyq-bk-';
export const CLOUDS = ['community', 'community-secure', 'secure'];
export const MAX_MACHINES = 8;
export const DEFAULT_HOURS = 10;          // what the balance must cover when no end time is set

const iso = (v, what) => {
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw new Error(`${what}: enter a date and time`);
    return new Date(t).toISOString();
};

/** A booking as the owner typed it, checked and normalised. Throws with a plain message. */
export function validateBooking(input, { now = Date.now(), workflows = [] } = {}) {
    const b = input || {};
    const count = Number(b.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_MACHINES) throw new Error(`how many machines: 1 to ${MAX_MACHINES}`);
    const minVramGb = Number(b.minVramGb);
    if (!(minVramGb >= 8 && minVramGb <= 200)) throw new Error('minimum GPU size: 8 to 200 GB of VRAM');
    const maxPricePerHr = Number(b.maxPricePerHr);
    if (!(maxPricePerHr > 0 && maxPricePerHr <= 20)) throw new Error('price cap: more than $0 and at most $20 per hour per machine');
    // Shared storage: a RunPod network volume exists only on Secure Cloud and pins
    // every Pod to its data centre, so a booking on one is Secure there.
    const volumeId = b.volumeId && b.volumeId !== 'none' ? String(b.volumeId) : null;
    const cloud = volumeId ? 'secure' : CLOUDS.includes(b.cloud) ? b.cloud : 'community';
    const serve = Array.isArray(b.serve) ? [...new Set(b.serve.map(String).filter(Boolean))] : [];
    const known = new Set(workflows.map(w => w.id));
    const unknown = serve.filter(id => !known.has(id));
    if (workflows.length && unknown.length) throw new Error(`not in the library: ${unknown.join(', ')}`);
    const startAt = iso(b.startAt || new Date(now).toISOString(), 'start hunting at');
    const readyBy = b.readyBy ? iso(b.readyBy, 'ready by') : null;
    const endAt = b.endAt ? iso(b.endAt, 'shut down at') : null;
    if (readyBy && Date.parse(readyBy) < Date.parse(startAt)) throw new Error('"ready by" is before the start of the hunt');
    if (endAt && Date.parse(endAt) <= Date.parse(startAt)) throw new Error('"shut down at" must be after the start of the hunt');
    if (endAt && Date.parse(endAt) <= now) throw new Error('"shut down at" is already past');
    const name = String(b.name || '').trim().slice(0, 60) || `Workshop ${new Date(startAt).toISOString().slice(0, 10)}`;
    return {
        name, count, minVramGb, maxPricePerHr, cloud, serve, volumeId,
        startAt, readyBy, endAt,
        keepHunting: b.keepHunting !== false,
        diskGb: Number(b.diskGb) > 0 ? Math.round(Number(b.diskGb)) : null,
    };
}

/** The machines of a booking among RunPod's Pods (by name), and whether each is still on. */
export const podPrefix = (b) => `${BOOKING_PREFIX}${b.id}-`;
export function podsOf(b, pods = []) {
    return pods.filter(p => String(p.name || '').startsWith(podPrefix(b)));
}
export const isLive = (p) => p.desiredStatus === 'RUNNING';

/**
 * The cards worth asking for, cheapest first: launchable, at least the VRAM
 * asked for (and what the workflows need), priced at or under the cap.
 * @param rows rankGpus(...).rows for one cloud
 */
export function cardsFor(rows = [], { minVramGb, maxPricePerHr }) {
    return rows
        .filter(r => r.launchable !== false && r.fits !== false && r.pricePerHr != null
            && Number(r.vramGb) >= minVramGb && r.pricePerHr <= maxPricePerHr)
        .sort((a, b) => a.pricePerHr - b.pricePerHr || a.vramGb - b.vramGb)
        .map(r => ({ id: r.id, name: r.name, vramGb: r.vramGb, pricePerHr: r.pricePerHr }));
}

/** The clouds to try this minute, in order. */
export const cloudsFor = (b) => b.cloud === 'secure' ? [false] : b.cloud === 'community-secure' ? [true, false] : [true];

/** Disk for a machine with no network volume: its models, results and room to spare. */
export const podDiskFor = (downloadGb, asked) => Math.max(asked || 0, Math.ceil((Number(downloadGb) || 0) * 1.05 + 15), 40);

/**
 * What to do with one booking this minute.
 * @returns {{ action: 'none'|'wait'|'launch'|'hold'|'end'|'finish', missing?: number, late?: boolean }}
 */
export function decide(b, now, live = []) {
    if (['stopped', 'ended'].includes(b.state)) return { action: 'none' };
    const start = Date.parse(b.startAt);
    const end = b.endAt ? Date.parse(b.endAt) : null;
    if (end && now >= end) return live.length ? { action: 'end' } : { action: 'finish' };
    if (now < start) return { action: 'wait' };
    const missing = b.count - live.length;
    if (missing <= 0) return { action: 'hold' };
    const late = !!b.readyBy && now > Date.parse(b.readyBy);
    if (late && !b.keepHunting) return { action: 'hold', late: true, missing };
    return { action: 'launch', missing, late };
}

/** Hours the balance must still pay for at the cap: until the end time, else DEFAULT_HOURS. */
export function hoursToCover(b, now) {
    const end = b.endAt ? Date.parse(b.endAt) : null;
    const from = Math.max(now, Date.parse(b.startAt));
    return end ? Math.max(1, (end - from) / 3600_000) : DEFAULT_HOURS;
}

/** One line for the tray and the page. */
export function statusLine(b, live = [], now = Date.now()) {
    const n = live.length;
    const d = decide(b, now, live);
    const when = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const head = `${b.name}: ${n} of ${b.count} ready`;
    if (b.state === 'stopped') return `${head} · stopped`;
    if (b.state === 'ended') return `${b.name}: ended`;
    if (d.action === 'wait') return `${b.name}: hunting from ${when(b.startAt)}`;
    if (d.action === 'launch') return `${head} · hunting${b.tries ? ` (${b.tries} tries)` : ''}${b.blocked ? ` · ${b.blocked}` : ''}`;
    if (d.action === 'hold' && d.late) return `${head} · stopped hunting at ${when(b.readyBy)}`;
    if (d.action === 'end' || d.action === 'finish') return `${head} · shutting down`;
    return `${head}${b.endAt ? ` · until ${when(b.endAt)}` : ''}`;
}
