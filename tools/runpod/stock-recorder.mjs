#!/usr/bin/env node
// RunPod GPU stock recorder. RunPod only says what is in stock NOW and keeps
// no history, so this takes a reading and appends it to a file; run often
// enough, the file shows when each data centre usually has which cards.
//
//   RUNPOD_API_KEY=… node tools/runpod/stock-recorder.mjs [--out stock] [--dcs EU-RO-1,EU-CZ-1]
//
// A READ-ONLY key is enough and is the right one to use: this only reads
// stock, and a read-only key cannot create Pods or spend money. Run every
// 15 minutes by .github/workflows/runpod-stock.yml, which commits the files to
// the `runpod-stock` branch; the console's Stock tab reads them from there.
//
// One JSON line per reading, in <out>/YYYY-MM.jsonl (UTC month):
//   { "at": "2026-10-19T22:15:03Z",
//     "dc": { "EU-RO-1": [["NVIDIA GeForce RTX 5090", "Low", 1.19], …], … },
//     "failed": ["US-XX-1"] }
// Only cards IN STOCK are listed (a card absent from a data centre's list was
// not available there), and only NVIDIA cards of 24 GB or more — the ones
// ComfyQ's workflows can use — to keep the files small.
import fs from 'fs';
import path from 'path';
import { gpuTypes } from './lib.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const KEY = process.env.RUNPOD_API_KEY;
if (!KEY) { console.error('set RUNPOD_API_KEY (a read-only key is enough)'); process.exit(1); }
const OUT = arg('out') || 'stock';
const MIN_VRAM = 24;
// RunPod's data centres (from its OpenAPI spec, 2026-10-19).
const ALL_DCS = ['EU-RO-1', 'EU-SE-1', 'EU-CZ-1', 'EU-NL-1', 'EU-FR-1', 'EUR-IS-1', 'EUR-IS-2', 'EUR-IS-3', 'EUR-NO-1',
    'CA-MTL-1', 'CA-MTL-2', 'CA-MTL-3', 'US-IL-1', 'US-TX-1', 'US-TX-3', 'US-TX-4', 'US-KS-2', 'US-KS-3', 'US-GA-1', 'US-GA-2',
    'US-WA-1', 'US-CA-2', 'US-NC-1', 'US-DE-1', 'US-MD-1', 'US-MO-1', 'US-MO-2', 'OC-AU-1', 'AP-JP-1', 'AP-IN-1'];
const DCS = arg('dcs') ? arg('dcs').split(',').map(s => s.trim()).filter(Boolean) : ALL_DCS;

const reading = { at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), dc: {}, failed: [] };
// A few data centres at a time: polite to the API, and quick enough.
for (let i = 0; i < DCS.length; i += 5) {
    await Promise.all(DCS.slice(i, i + 5).map(async (dc) => {
        try {
            const { gpus, scopedToDataCenter } = await gpuTypes(KEY, { dataCenterId: dc });
            // Unscoped figures say nothing about this data centre: record it as failed.
            if (!scopedToDataCenter) { reading.failed.push(dc); return; }
            reading.dc[dc] = gpus
                .filter(g => g.vramGb >= MIN_VRAM && g.stock && g.stock !== 'None')
                .map(g => [g.id, g.stock, g.pricePerHr == null ? null : +Number(g.pricePerHr).toFixed(3)])
                .sort((a, b) => a[0].localeCompare(b[0]));
        } catch { reading.failed.push(dc); }
    }));
}

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `${reading.at.slice(0, 7)}.jsonl`);
fs.appendFileSync(file, JSON.stringify(reading) + '\n');
const inStock = Object.values(reading.dc).reduce((n, l) => n + l.length, 0);
console.log(`${reading.at}: ${Object.keys(reading.dc).length} data centres read, ${inStock} card types in stock`
    + (reading.failed.length ? `, could not read ${reading.failed.join(', ')}` : '') + ` → ${file}`);
if (reading.failed.length === DCS.length) process.exit(1);
