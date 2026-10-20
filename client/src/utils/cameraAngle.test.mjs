/**
 * The booking widget tells a student which shot they have framed. If its
 * bucketing drifted from the server's, the phrase on screen and the phrase the
 * model receives would quietly disagree — and nothing else would notice.
 *
 * ★ So both copies are pinned to the SAME fixture, generated from ComfyUI's own
 * `describe_camera_angle` over a 5110-point grid. This is the client half;
 * server/workers/cameraAngle.test.js is the other.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe as describeCam, parseCamera, formatCamera, sectorIndex, cameraPosition } from './cameraAngle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(
    path.resolve(here, '../../../server/workers/cameraAngle.fixture.json'), 'utf8'));

let passed = 0;
const test = (name, fn) => {
    try { fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('cameraAngle (client) — the readout matches what the node will say');

const SPEC = {
    axes: {
        horizontal: { min: 0, max: 360, step: 1, default: 0, wrap: true },
        vertical: { min: -30, max: 60, step: 1, default: 0 },
        zoom: { min: 0, max: 10, step: 0.1, default: 5 },
    },
    phrase: [
        { axis: 'horizontal', sectors: FIX.horizontalTerms },
        { axis: 'vertical', thresholds: FIX.verticalThresholds, terms: FIX.verticalTerms },
        { axis: 'zoom', thresholds: FIX.distanceThresholds, terms: FIX.distanceTerms },
    ],
};

test(`all ${FIX.rows.length} fixture points read back exactly as ComfyUI phrases them`, () => {
    const wrong = [];
    for (const r of FIX.rows) {
        const got = describeCam(SPEC, { horizontal: r.h, vertical: r.v, zoom: r.z });
        if (got !== r.phrase) wrong.push(`h=${r.h} v=${r.v} z=${r.z}: "${got}" vs "${r.phrase}"`);
    }
    assert.deepStrictEqual(wrong.slice(0, 5), [], `${wrong.length} disagree`);
});

test('azimuth wraps, elevation and zoom clamp', () => {
    assert.strictEqual(parseCamera('{"horizontal":370}', SPEC).horizontal, 10);
    assert.strictEqual(parseCamera('{"horizontal":-10}', SPEC).horizontal, 350);
    assert.strictEqual(parseCamera('{"vertical":999}', SPEC).vertical, 60);
    assert.strictEqual(parseCamera('{"zoom":-3}', SPEC).zoom, 0);
});

test('a broken value falls back to the declared defaults', () => {
    for (const bad of [undefined, null, '', 'nope', '{', 7]) {
        assert.deepStrictEqual(parseCamera(bad, SPEC), { horizontal: 0, vertical: 0, zoom: 5 });
    }
});

test('format/parse round-trip', () => {
    const c = { horizontal: 74, vertical: 42, zoom: 5.3 };
    assert.deepStrictEqual(parseCamera(formatCamera(c), SPEC), c);
});

test('the gizmo sits where the node puts its camera', () => {
    const front = cameraPosition({ horizontal: 0, vertical: 0, zoom: 5 });
    assert.ok(Math.abs(front.z - 6) < 1e-9 && Math.abs(front.x) < 1e-9, 'front is +Z at distance 6');
    const right = cameraPosition({ horizontal: 90, vertical: 0, zoom: 5 });
    assert.ok(Math.abs(right.x - 6) < 1e-9 && Math.abs(right.z) < 1e-9, '90° is +X');
    const up = cameraPosition({ horizontal: 0, vertical: 90, zoom: 5 });
    assert.ok(Math.abs(up.y - 6) < 1e-9, 'elevation lifts it on Y');
});

test('sectors are centred, so the front spans the seam', () => {
    assert.strictEqual(sectorIndex(0, 8), 0);
    assert.strictEqual(sectorIndex(350, 8), 0);
    assert.strictEqual(sectorIndex(23, 8), 1);
});

console.log(`\ncameraAngle (client): all ${passed} checks passed`);
if (process.exitCode) process.exit(process.exitCode);
