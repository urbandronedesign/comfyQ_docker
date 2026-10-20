// node tools/runpod/tests/console-security.mjs — the console server's locks.
//
// A real server.mjs, started as RunPod-Console.bat starts it (no token given),
// with a throwaway home folder, a fake RunPod REST API and a fake, hostile Pod.
// Checks the fixes from the 2026-10-20 security audit:
//   - the browser version has a random token: the old fixed '1' is refused;
//   - the link it opens carries the token, and that token works;
//   - another Host (DNS rebinding) is refused;
//   - errors are plain text the browser will not run (nosniff + sandbox);
//   - a results download never relays the Pod's own (HTML) answer;
//   - the admin password goes only to a Pod of the account;
//   - an image that is not ComfyQ's must be confirmed.
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'console', 'server.mjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0, bad = 0;
const check = (name, ok) => { n++; if (!ok) { bad++; console.log(`  FAIL ${name}`); } };

// Fake RunPod REST (only the Pod 'abc' exists) and a fake Pod that answers its
// results request with hostile HTML, noting any admin password it is sent.
const passwordsSeen = [];
const fake = http.createServer((req, res) => {
    if (req.url === '/v1/pods/abc') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'abc' })); }
    if (req.url.startsWith('/v1/pods/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"pod not found"}'); }
    if (req.url.includes('/admin/volume-folders/')) {
        passwordsSeen.push({ host: req.headers.host, url: req.url, password: req.headers['x-admin-password'] });
        res.writeHead(502, { 'Content-Type': 'text/html' });
        return res.end('<html><script>fetch("/api/settings")</script>pwned</html>');
    }
    res.writeHead(404); res.end();
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const F = `http://127.0.0.1:${fake.address().port}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'console-sec-'));
fs.mkdirSync(path.join(home, '.comfyq'));
fs.writeFileSync(path.join(home, '.comfyq', 'runpod-console.json'), JSON.stringify({ runpodApiKey: 'rpa_test_key_0123456789', adminPassword: 'admin-secret-pw' }));
const PORT = 4793;
const env = { ...process.env, USERPROFILE: home, HOME: home, COMFYQ_CONSOLE_PORT: String(PORT), RUNPOD_REST_URL: `${F}/v1`, COMFYQ_POD_PROXY: `${F}/pod/{id}` };
delete env.COMFYQ_CONSOLE_TOKEN;
const srv = spawn(process.execPath, [SERVER, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', d => { out += d; });
srv.stderr.on('data', d => { out += d; });

const base = `http://127.0.0.1:${PORT}`;
const call = (route, { method = 'GET', token, host, body } = {}) => fetch(base + route, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { ...(token ? { 'X-ComfyQ-Console': token } : {}), ...(host ? { Host: host } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
});
try {
    for (let i = 0; i < 50 && !/http:\/\/localhost/.test(out); i++) await sleep(200);
    const link = (out.match(/http:\/\/localhost:\d+\/#t=([A-Za-z0-9]+)/) || [])[1];
    check(`the browser version prints a link with a random token (${link ? link.length + ' characters' : 'none'})`, !!link && link.length >= 32);
    const urlFile = fs.readFileSync(path.join(home, '.comfyq', 'console-url.txt'), 'utf8');
    check('and keeps it for a second start to open', urlFile.includes(link || 'x'));
    check('the old fixed header is refused', (await call('/api/settings', { token: '1' })).status === 403);
    check('no header is refused', (await call('/api/settings')).status === 403);
    const ok = await call('/api/settings', { token: link });
    check(`the token works (${ok.status})`, ok.status === 200);
    // fetch() will not send a made-up Host header: plain http does.
    const rebound = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/settings', headers: { Host: 'evil.example:4793', 'X-ComfyQ-Console': link } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0)));
    check(`another Host (DNS rebinding) is refused (${rebound})`, rebound === 403);

    const nf = await call('/nothing-here');
    check('a 404 is plain text, not run by the browser', nf.status === 404 && /text\/plain/.test(nf.headers.get('content-type')) && nf.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(nf.headers.get('content-security-policy') || ''));
    const page = await call('/');
    check('the page itself says nosniff', page.headers.get('x-content-type-options') === 'nosniff');

    // A results download from a hostile Pod.
    const d = await (await call('/api/pods/abc/download', { method: 'POST', token: link })).json();
    const zip = await fetch(base + d.url);
    const text = await zip.text();
    check(`a failed download is our own plain text, not the Pod's HTML (${zip.status}: ${text.slice(0, 60)})`,
        /text\/plain/.test(zip.headers.get('content-type')) && !/<script/i.test(text) && /sandbox/.test(zip.headers.get('content-security-policy') || ''));
    // A Pod that is not in the account.
    const before = passwordsSeen.length;
    const missing = await call('/api/pods/zzz/download', { method: 'POST', token: link });
    check(`a Pod not in the account gets no download, and no admin password (${missing.status})`, missing.status >= 400 && passwordsSeen.length === before && !passwordsSeen.some(p => p.url.includes('/zzz')));

    // An image that is not ComfyQ's.
    const foreign = await call('/api/settings', { method: 'PUT', token: link, body: { image: 'docker.io/someone/thing:latest' } });
    check(`a foreign image is refused until confirmed (${foreign.status})`, foreign.status === 409);
    const own = await call('/api/settings', { method: 'PUT', token: link, body: { image: 'ghcr.io/urbandronedesign/comfyq:sha-2df128e' } });
    check(`ComfyQ's own image is taken as is (${own.status})`, own.status === 200);
    const confirmed = await call('/api/settings', { method: 'PUT', token: link, body: { image: 'docker.io/someone/thing:latest', allowCustomImage: true } });
    check(`and a foreign one once confirmed (${confirmed.status})`, confirmed.status === 200);
    await call('/api/settings', { method: 'PUT', token: link, body: { image: '' } });

    // Errors never carry a secret value.
    const err = await (await call('/api/pods/zzz', { token: link })).json();
    check('error messages carry no secret value', !JSON.stringify(err).includes('rpa_test_key_0123456789') && !JSON.stringify(err).includes('admin-secret-pw'));
} catch (e) {
    console.log(`  BROKEN ${e.message}\n${out}`); bad++;
} finally {
    srv.kill(); fake.close();
    await sleep(300);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* still held */ }
}
console.log(`console security: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
