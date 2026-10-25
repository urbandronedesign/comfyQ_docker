#!/usr/bin/env node
// The rules for the owner's own machines (home.mjs).
import { cleanName, cleanAddress, idFor, nextHealth, homeStage, MISSES_FOR_OFFLINE } from './home.mjs';

let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// ---- names ----
check('a name is kept, spaces collapsed', cleanName('  atelier   4090 ') === 'atelier 4090');
check('an empty name is refused', throws(() => cleanName('  '), /give the machine a name/));
check('a long name is refused', throws(() => cleanName('x'.repeat(41)), /under 40/));
check('a name with markup is refused', throws(() => cleanName('<b>pc</b>'), /letters, digits/));
check('accents are fine', cleanName('Atelier Pré') === 'Atelier Pré');

// ---- addresses ----
check('a Funnel address is kept as is', cleanAddress('https://atelier-4090.tail1234.ts.net') === 'https://atelier-4090.tail1234.ts.net');
check('a trailing slash is dropped', cleanAddress('https://atelier-4090.tail1234.ts.net/') === 'https://atelier-4090.tail1234.ts.net');
check('no scheme reads as https', cleanAddress('atelier-4090.tail1234.ts.net') === 'https://atelier-4090.tail1234.ts.net');
check('plain http with a port (the private Tailscale address) is kept', cleanAddress('http://atelier-4090:3000') === 'http://atelier-4090:3000');
check('a page in the address is refused, with the reason', throws(() => cleanAddress('https://a.ts.net/admin'), /without a page/));
check('a query is refused', throws(() => cleanAddress('https://a.ts.net/?x=1'), /without a page/));
check('javascript: is refused', throws(() => cleanAddress('javascript:alert(1)'), /https:\/\//));
check('file: is refused', throws(() => cleanAddress('file:///C:/x'), /https:\/\//));
check('a user and password in the address are refused', throws(() => cleanAddress('https://me:pw@a.ts.net'), /user and password/));
check('nonsense is refused', throws(() => cleanAddress('https://'), /not an address|no machine name/));
check('an empty address is refused', throws(() => cleanAddress(''), /Funnel address/));

// ---- ids ----
check('an id from the name', idFor('Atelier 4090') === 'atelier-4090');
check('a taken id gets a number', idFor('atelier 4090', ['atelier-4090']) === 'atelier-4090-2');
check('accents leave the id', idFor('Pré') === 'pre');
check('a name of symbols still gets an id', idFor('___') === 'machine');

// ---- health ----
let h = nextHealth(null, false, 1000);
check('never answered: offline at once', h.online === false && h.lastSeen === null && h.misses === 1);
h = nextHealth(h, true, 2000);
check('answers: online, seen now', h.online && h.lastSeen === 2000 && h.misses === 0);
h = nextHealth(h, false, 3000);
check(`one missed answer after being seen is not offline yet`, h.online && h.misses === 1);
for (let i = 1; i < MISSES_FOR_OFFLINE; i++) h = nextHealth(h, false, 4000 + i);
check(`${MISSES_FOR_OFFLINE} missed answers in a row: offline, last seen kept`, !h.online && h.lastSeen === 2000);
h = nextHealth(h, true, 9000);
check('back: online again', h.online && h.misses === 0 && h.lastSeen === 9000);

// ---- stages ----
const up = { online: true, lastSeen: 1, misses: 0 };
check('no health yet: checking', homeStage(null, null).key === 'checking');
check('offline, never seen', /does not answer/.test(homeStage(null, { online: false, lastSeen: null }).text));
check('offline after being seen', /stopped answering/.test(homeStage(null, { online: false, lastSeen: 5 }).text));
check('one miss while still online: checking', homeStage({ answering: false }, { online: true, lastSeen: 1, misses: 1 }).key === 'checking');
const serving = homeStage({ answering: true, mode: 'student', served: [{ id: 'image_flux3', name: 'FLUX.3 edit' }] }, up);
check('serving names the workflows', serving.key === 'serving' && /FLUX\.3 edit/.test(serving.text));
check('admin mode', homeStage({ answering: true, mode: 'admin', served: [] }, up).key === 'admin');
check('downloading models', /Downloading/.test(homeStage({ answering: true, mode: 'admin', served: [], plan: { status: 'fetching' } }, up).text));

console.log(`home: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
