// The owner's own machines (a PC with its own GPU, reached over the internet,
// for instance through a Tailscale Funnel: https://atelier-4090.<tailnet>.ts.net).
// Nothing is rented or billed: the console only keeps the list, reads each
// machine's status (probeUrl, as for a Pod) and gives the links.
//
// Pure rules here (home.test.mjs); the routes are in console/server.mjs.

/** A machine's name: what it is called in the list and in notifications. */
export function cleanName(name) {
    const n = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!n) throw new Error('give the machine a name (for instance atelier-4090)');
    if (n.length > 40) throw new Error('keep the name under 40 characters');
    if (!/^[\p{L}\p{N} ._-]+$/u.test(n)) throw new Error('the name can hold letters, digits, spaces, dots, dashes and underscores');
    return n;
}

/**
 * Where ComfyQ answers on that machine, reduced to scheme://host[:port].
 * Only http(s), never a user or password in it (the address is shown and
 * opened as a link), and no path: the console adds its own.
 */
export function cleanAddress(address) {
    let raw = String(address ?? '').trim();
    if (!raw) throw new Error('give the machine\'s address (its Funnel address, https://<name>.<tailnet>.ts.net)');
    // "name:3000" is a host and a port; "javascript:…" or "file:…" is a scheme.
    if (!/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)) raw = `https://${raw}`;
    let u;
    try { u = new URL(raw); } catch { throw new Error(`${address} is not an address`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('the address must start with https:// (or http://)');
    if (u.username || u.password) throw new Error('leave the user and password out of the address');
    if (!u.hostname) throw new Error(`${address} has no machine name`);
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
        throw new Error('give only the machine\'s address, without a page (https://atelier-4090.<tailnet>.ts.net, not …/admin or …/user)');
    }
    return `${u.protocol}//${u.host}`;
}

/** A short id from the name, not already taken. */
export function idFor(name, taken = []) {
    const base = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'machine';
    const used = new Set(taken);
    if (!used.has(base)) return base;
    for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

// One missed answer is not "offline": a Funnel relay or a busy machine can
// miss one probe. Offline = it never answered since the console started, or
// it has missed this many probes in a row.
export const MISSES_FOR_OFFLINE = 2;

/** Fold one probe into what is known of the machine's health. */
export function nextHealth(prev, answering, now) {
    const h = { lastSeen: prev?.lastSeen ?? null, misses: prev?.misses ?? 0, checkedAt: now };
    if (answering) { h.lastSeen = now; h.misses = 0; }
    else h.misses += 1;
    h.online = answering || (h.lastSeen != null && h.misses < MISSES_FOR_OFFLINE);
    return h;
}

/**
 * Where the machine is, from its probe and its health:
 *   offline · admin (ComfyQ answers, serves nothing) · serving · checking.
 */
export function homeStage(probe, health) {
    if (!health) return { key: 'checking', text: 'Checking…' };
    if (!health.online) {
        return { key: 'offline', text: health.lastSeen ? 'Offline: it stopped answering' : 'Offline: it does not answer (off, asleep, ComfyQ not started, or the Funnel is closed)' };
    }
    if (!probe?.answering) return { key: 'checking', text: 'Missed one answer, checking again' };
    if (probe.mode === 'student' && (probe.served || []).length) return { key: 'serving', text: `Serving ${probe.served.map(w => w.name || w.id).join(', ')}` };
    if (probe.plan?.status === 'fetching') return { key: 'admin', text: 'Downloading models' };
    return { key: 'admin', text: 'Up in admin mode: pick a workflow in its admin panel' };
}
