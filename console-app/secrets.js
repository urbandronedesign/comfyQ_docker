// The console's keys and passwords, encrypted for this Windows account
// (DPAPI, through Electron's safeStorage) in ~/.comfyq/console-secrets.bin.
//
// The first start moves them out of the plain ~/.comfyq/runpod-console.json:
// encrypt, write, read back and compare, and only then remove them from the
// plain file — a failed write never loses a key. After that the browser
// version (RunPod-Console.bat) no longer sees them; it asks for them again.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRET_KEYS = ['runpodApiKey', 'thunderApiKey', 'vastApiKey', 'adminPassword', 'accessPassword', 'hfToken'];

function dataDir() {
    return path.join(process.env.COMFYQ_APP_SERVER_HOME || os.homedir(), '.comfyq');
}
const secretsFile = () => path.join(dataDir(), 'console-secrets.bin');
const settingsFile = () => path.join(dataDir(), 'runpod-console.json');

function pick(obj) {
    const out = {};
    for (const k of SECRET_KEYS) if (obj && typeof obj[k] === 'string' && obj[k]) out[k] = obj[k];
    return out;
}

function writeAtomic(file, data, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', data, { mode });
    fs.renameSync(file + '.tmp', file);
}

function create(safeStorage) {
    const available = !!safeStorage && safeStorage.isEncryptionAvailable();

    function save(secrets) {
        const clean = pick(secrets);
        writeAtomic(secretsFile(), safeStorage.encryptString(JSON.stringify(clean)));
        return clean;
    }

    function read() {
        if (!fs.existsSync(secretsFile())) return null;
        return pick(JSON.parse(safeStorage.decryptString(fs.readFileSync(secretsFile()))));
    }

    /** The keys, moving any still in the plain settings file into the encrypted one. */
    function load() {
        const stored = read() || {};
        let plain;
        try { plain = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { plain = null; }
        const inPlain = pick(plain);
        if (!Object.keys(inPlain).length) return { secrets: stored, migrated: [] };
        // A key typed in the browser version later wins over an older stored one.
        const merged = { ...stored, ...inPlain };
        save(merged);
        const back = read();
        if (JSON.stringify(back) !== JSON.stringify(pick(merged))) throw new Error('the encrypted keys did not read back the same: the plain file was left as it is');
        for (const k of SECRET_KEYS) delete plain[k];
        writeAtomic(settingsFile(), JSON.stringify(plain, null, 2));
        return { secrets: back, migrated: Object.keys(inPlain) };
    }

    return { available, load, save, file: secretsFile };
}

module.exports = { create, SECRET_KEYS };
