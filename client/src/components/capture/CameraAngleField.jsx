import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Camera, RotateCcw } from 'lucide-react';
import {
    axisSpec, parseCamera, formatCamera, describeParts, cameraPosition,
    SUBJECT_DISTANCE, CAMERA_FOV,
} from '../../utils/cameraAngle';

// CameraAngleField — place the camera around the subject, the way ComfyUI's own
// "Compose Camera Angle Prompt" node does, instead of picking a phrase from a
// dropdown.
//
// ★ The scene is the one the node describes: the subject sits at the origin with
// the uploaded picture on its front, and the camera rides a sphere of radius 6
// with a 35° lens. The gizmo is therefore not a decoration — it is at the
// position `camera_info` would report.
//
// ★★ And the readout under it is the point of the whole widget. What reaches the
// model is NOT the angle: it is a phrase chosen from a short list ("right side
// view elevated shot medium shot"). So the sentence is shown live, and a drag
// that changes the picture is visibly different from one that does not. A
// student who cannot see that would reasonably expect 1° of control over a
// control that has about 24 distinct positions.

const DRAG_DEG_PER_PX = 0.55;      // a comfortable full turn in ~650 px of drag
const PRESETS = [
    { label: 'Front', h: 0 }, { label: 'Right', h: 90 },
    { label: 'Back', h: 180 }, { label: 'Left', h: 270 },
];

function buildScene(mount, getPreviewTexture) {
    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';

    // The overview camera. Fixed: the student moves the SUBJECT's camera, not
    // this one, so the frame of reference stays still and the gizmo's travel
    // reads as the camera moving round the subject.
    const view = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    view.position.set(7.4, 5.6, 9.8);
    view.lookAt(0, 0.1, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, 10, 8);
    scene.add(key);

    // Ground + the orbit the camera rides.
    const grid = new THREE.GridHelper(14, 14, 0x5a5a66, 0x33333c);
    grid.position.y = -1.6;
    scene.add(grid);
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(SUBJECT_DISTANCE - 0.05, SUBJECT_DISTANCE + 0.05, 96),
        new THREE.MeshBasicMaterial({ color: 0x8c8c99, side: THREE.DoubleSide, transparent: true, opacity: 0.45 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -1.6;
    scene.add(ring);

    // The subject: a slab carrying the uploaded picture on its front face.
    const subject = new THREE.Mesh(
        new THREE.BoxGeometry(2.1, 2.1, 0.26),
        [0, 1, 2, 3, 4, 5].map(() => new THREE.MeshStandardMaterial({ color: 0x3f3f49, roughness: 0.85 })));
    scene.add(subject);
    // A nose on +Z so "front view" is unmistakable even with no picture loaded.
    const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.17, 0.42, 16),
        new THREE.MeshStandardMaterial({ color: 0x9aa4b2 }));
    nose.position.set(0, -1.4, 1.0);
    nose.rotation.x = Math.PI / 2;
    scene.add(nose);

    // The camera gizmo: a cone pointing at the subject, plus its sight line.
    const gizmo = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.ConeGeometry(0.42, 1.0, 20),
        new THREE.MeshStandardMaterial({ color: 0xf0b429, roughness: 0.4 }));
    body.rotation.x = Math.PI / 2;      // cone tip toward -Z, i.e. toward the subject
    gizmo.add(body);
    scene.add(gizmo);
    const sight = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0xf0b429, transparent: true, opacity: 0.6 }));
    scene.add(sight);

    let texture = null;
    const setPreview = (url) => {
        if (texture) { texture.dispose(); texture = null; }
        if (!url) { subject.material[4].map = null; subject.material[4].needsUpdate = true; return; }
        new THREE.TextureLoader().load(url, (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            texture = t;
            subject.material[4].map = t;                 // +Z face
            subject.material[4].color.set(0xffffff);
            subject.material[4].needsUpdate = true;
        }, undefined, () => { /* a preview that will not decode is not an error */ });
    };
    setPreview(getPreviewTexture);

    const place = (cam) => {
        const p = cameraPosition(cam);
        gizmo.position.set(p.x, p.y, p.z);
        gizmo.lookAt(0, 0, 0);
        // Zoom reads as how close the lens crops, so show it as the gizmo
        // closing on the subject rather than as a number nobody can picture.
        const t = Math.min(1, Math.max(0, cam.zoom / 10));
        const s = 0.55 + 0.75 * t;
        gizmo.scale.setScalar(s);
        sight.geometry.setFromPoints([new THREE.Vector3(p.x, p.y, p.z), new THREE.Vector3(0, 0, 0)]);
    };

    const resize = () => {
        const w = mount.clientWidth || 1;
        const h = mount.clientHeight || 1;
        renderer.setSize(w, h, false);
        view.aspect = w / h;
        view.updateProjectionMatrix();
    };

    const render = () => renderer.render(scene, view);

    const dispose = () => {
        if (texture) texture.dispose();
        renderer.dispose();
        scene.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            const m = o.material;
            if (Array.isArray(m)) m.forEach(x => x.dispose()); else if (m) m.dispose();
        });
        if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };

    return { place, resize, render, setPreview, dispose };
}

// ★ Defined HERE, not inside CameraAngleField. An arrow function declared in a
// render body is a new component TYPE every render, so React unmounts the
// <input type="range"> and mounts a fresh one as soon as the first change
// fires — which is mid-drag. The browser's pointer capture dies with the old
// element and the slider can only be clicked, never dragged.
const AxisSlider = ({ axis, spec, value, suffix, title, disabled, onChange }) => (
    <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-muted">{title}</span>
            <span className="text-[11px] font-mono text-slate-300">
                {spec.step >= 1 ? Math.round(value) : value.toFixed(1)}{suffix}
            </span>
        </div>
        <input
            type="range"
            min={spec.min} max={spec.max} step={spec.step} value={value}
            disabled={disabled}
            onChange={(e) => onChange(axis, parseFloat(e.target.value))}
            className="w-full h-5 accent-primary cursor-pointer"
            aria-label={title}
        />
    </div>
);

const CameraAngleField = ({ paramKey, label, config, value, onChange, previewUrl, disabled }) => {
    const spec = config?.camera;
    const mountRef = useRef(null);
    const sceneRef = useRef(null);
    const dragRef = useRef(null);

    const cam = useMemo(() => parseCamera(value ?? config?.default, spec), [value, config?.default, spec]);
    const camRef = useRef(cam);
    camRef.current = cam;

    const hAxis = axisSpec(spec, 'horizontal');
    const vAxis = axisSpec(spec, 'vertical');
    const zAxis = axisSpec(spec, 'zoom');
    const parts = describeParts(spec, cam);

    const emit = useCallback((next) => {
        onChange(formatCamera(parseCamera(JSON.stringify(next), spec)));
    }, [onChange, spec]);

    const setAxis = useCallback((axis, v) => {
        emit({ ...camRef.current, [axis]: v });
    }, [emit]);

    // Build the scene once; it is cheap and only one of these is ever mounted.
    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return undefined;
        let s;
        try { s = buildScene(mount, previewUrl); }
        catch { return undefined; }                  // no WebGL — the sliders still work
        sceneRef.current = s;
        s.resize(); s.place(camRef.current); s.render();
        const ro = new ResizeObserver(() => { s.resize(); s.render(); });
        ro.observe(mount);
        return () => { ro.disconnect(); s.dispose(); sceneRef.current = null; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { sceneRef.current?.setPreview(previewUrl); sceneRef.current?.render(); }, [previewUrl]);
    useEffect(() => { sceneRef.current?.place(cam); sceneRef.current?.render(); }, [cam]);

    const onPointerDown = (e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        dragRef.current = { x: e.clientX, y: e.clientY, cam: camRef.current };
    };
    const onPointerMove = (e) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        emit({
            ...d.cam,
            horizontal: d.cam.horizontal + dx * DRAG_DEG_PER_PX,
            vertical: d.cam.vertical + dy * DRAG_DEG_PER_PX,
        });
    };
    const endDrag = (e) => {
        if (!dragRef.current) return;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        dragRef.current = null;
    };
    const onWheel = (e) => {
        if (disabled) return;
        e.preventDefault();
        setAxis('zoom', camRef.current.zoom + (e.deltaY < 0 ? 0.5 : -0.5));
    };

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300 flex items-center gap-2 flex-wrap">
                <Camera size={14} className="text-primary" />
                <span>{label}</span>
                <span className="text-[10px] text-muted font-normal">— drag to orbit, scroll to zoom</span>
            </label>

            <div className={`rounded-xl border border-border bg-surface/30 overflow-hidden ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
                <div
                    ref={mountRef}
                    data-testid={`camera-stage-${paramKey}`}
                    className="relative h-56 w-full cursor-grab active:cursor-grabbing bg-background/40"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onWheel={onWheel}
                />

                {/* What the model is actually told. Shown as the separate terms it
                    is, so it is obvious the control is a short list of shots. */}
                <div className="px-3 py-2 border-t border-border bg-background/50">
                    <div className="text-[10px] uppercase tracking-wide text-muted mb-1">The model is told</div>
                    <div className="flex flex-wrap gap-1.5" data-testid={`camera-phrase-${paramKey}`}>
                        {parts.length === 0 && <span className="text-xs text-muted italic">—</span>}
                        {parts.map((p, i) => (
                            <span key={i} className="px-2 py-0.5 rounded-md bg-primary/15 text-primary text-xs font-medium">
                                {p}
                            </span>
                        ))}
                    </div>
                </div>

                <div className="px-3 py-2.5 space-y-2.5 border-t border-border">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        {PRESETS.map(p => (
                            <button
                                key={p.label} type="button" disabled={disabled}
                                onClick={() => setAxis('horizontal', p.h)}
                                className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
                                    Math.round(cam.horizontal) % 360 === p.h
                                        ? 'border-primary/60 bg-primary/15 text-primary'
                                        : 'border-border text-muted hover:border-primary/40 hover:text-slate-300'}`}
                            >{p.label}</button>
                        ))}
                        <button
                            type="button" disabled={disabled}
                            onClick={() => emit({ horizontal: hAxis.default, vertical: vAxis.default, zoom: zAxis.default })}
                            className="ml-auto px-2 py-1 rounded-md text-[11px] border border-border text-muted hover:text-slate-300 inline-flex items-center gap-1"
                            title="Back to the default position"
                        ><RotateCcw size={11} /> Reset</button>
                    </div>
                    <AxisSlider axis="horizontal" spec={hAxis} value={cam.horizontal} suffix="°"
                        title="Around the subject" disabled={disabled} onChange={setAxis} />
                    <AxisSlider axis="vertical" spec={vAxis} value={cam.vertical} suffix="°"
                        title="Height (below ↔ above)" disabled={disabled} onChange={setAxis} />
                    <AxisSlider axis="zoom" spec={zAxis} value={cam.zoom} suffix=""
                        title="Framing (wide ↔ close-up)" disabled={disabled} onChange={setAxis} />
                </div>
            </div>
        </div>
    );
};

export default CameraAngleField;
