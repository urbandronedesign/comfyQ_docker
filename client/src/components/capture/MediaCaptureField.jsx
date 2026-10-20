import React, { useRef, useState } from 'react';
import { Upload, X, Image as ImageIcon, Video as VideoIcon, Music, Box, Loader2, AlertTriangle, RotateCw } from 'lucide-react';
import { resizeImageFile } from '../../utils/imageResize';

// Default image bounding box when the workflow's exposedParameter doesn't
// declare `maxInputEdge`: 1920×1080 in EITHER orientation (long edge ≤ 1920,
// short edge ≤ 1080). A per-parameter `maxInputEdge` overrides this with a
// single square long-edge cap. Admins set maxInputEdge in the metadata editor.
const DEFAULT_IMAGE_MAX_LONG = 1920;
const DEFAULT_IMAGE_MAX_SHORT = 1080;

// 3D meshes have no usable MIME prefix to filter on the way image/* and video/*
// do — a browser reports .obj and .stl as '' and .glb inconsistently — so the
// file picker and the drop target match on EXTENSION instead. These are the
// formats ComfyUI's own mesh reader opens.
const MODEL3D_EXTS = ['.glb', '.gltf', '.obj', '.stl', '.ply', '.fbx'];
const hasModel3dExt = (name) => MODEL3D_EXTS.some(e => (name || '').toLowerCase().endsWith(e));

// MediaCaptureField — image/video upload widget for BookingDialog.
//
// One entry point: a file input, reachable by click or drag-and-drop. (The
// camera / webcam capture path was removed — it required a secure context,
// and the workshop serves plain HTTP; users upload a file from their device
// instead. On a phone the OS file picker still offers "Take Photo" itself.)
//
// For images we run resizeImageFile() between selection and onChange, so the
// parent BookingDialog never sees the original raw 12 MP phone photo — it
// receives a downscaled JPEG/PNG matching `maxInputEdge`. Video isn't resized
// here (we don't transcode in-browser; phone-native MP4s are already
// reasonably sized at 1080p).
//
// The parent's handleMediaChange receives a File directly (not an event) so
// resizing can be async.
const MediaCaptureField = ({
    paramKey,
    label,
    type,           // 'image' | 'video' | 'audio' | 'model3d'
    maxInputEdge,   // optional; falls back to the 1920×1080 image box
    preview,        // dataURL string from parent's FileReader
    recalledName,   // optional: display name of an asset reused from a prior job
    onChange,       // (file: File) => void
    onRemove        // () => void
}) => {
    const fileInputRef = useRef(null);
    const [processing, setProcessing] = useState(false);
    const [dragActive, setDragActive] = useState(false);
    const [error, setError] = useState('');
    const [pickedName, setPickedName] = useState('');
    const isVideo = type === 'video';
    const isAudio = type === 'audio';
    const isModel3d = type === 'model3d';
    const isImage = type === 'image';
    const noun = isAudio ? 'audio' : isVideo ? 'video' : isModel3d ? '3D model' : 'image';
    // When maxInputEdge is set, use it as a square long-edge cap (legacy
    // single-edge behavior); otherwise the 1920×1080 box.
    const maxLong = maxInputEdge ?? DEFAULT_IMAGE_MAX_LONG;
    const maxShort = maxInputEdge ?? DEFAULT_IMAGE_MAX_SHORT;
    const acceptPrefix = `${type}/`;
    const acceptAttr = isModel3d ? MODEL3D_EXTS.join(',') : `${type}/*`;

    const handleFile = async (file) => {
        if (!file) return;
        setError('');
        if (isModel3d && !hasModel3dExt(file.name)) {
            setError(`That isn’t a 3D model file. Use one of ${MODEL3D_EXTS.join(', ')}.`);
            return;
        }
        setPickedName(file.name || '');
        // Reset the input value so picking the same file twice still fires.
        if (fileInputRef.current) fileInputRef.current.value = '';
        let processed = file;
        // Only images are resized; video/audio upload as-is (no in-browser transcode).
        if (isImage) {
            setProcessing(true);
            try {
                // Throws ImageProcessError on HEIC / undecodable / encode failure.
                // We surface that instead of uploading the raw original, which is
                // how an oversized phone photo used to reach (and crash) the rig.
                processed = await resizeImageFile(file, maxLong, { maxShort });
            } catch (e) {
                setError(e?.message || 'Couldn’t process this image. Please use a smaller JPEG or PNG.');
                return;
            } finally {
                setProcessing(false);
            }
        }
        onChange(processed);
    };

    // Drag-and-drop on the dashed border container. dragenter/over must
    // preventDefault so the browser doesn't navigate to the file. We track
    // dragActive on enter/leave so the border can highlight while a file is
    // hovering. Drop filters by MIME prefix (image/* or video/*) so dropping
    // a PDF on an image field does nothing rather than uploading garbage.
    const handleDragEnter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (processing || preview) return;
        setDragActive(true);
    };
    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };
    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
    };
    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (processing || preview) return;
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (isModel3d) {
            // Extension, not MIME: see MODEL3D_EXTS.
            if (!hasModel3dExt(file.name)) {
                console.warn(`[MediaCaptureField] ignored dropped file ${file.name} (expected a 3D model)`);
                return;
            }
        } else if (file.type && !file.type.startsWith(acceptPrefix)) {
            console.warn(`[MediaCaptureField] ignored dropped file of type ${file.type} (expected ${acceptPrefix}*)`);
            return;
        }
        handleFile(file);
    };

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300 flex items-center gap-2 flex-wrap">
                {isAudio
                    ? <Music size={14} className="text-primary" />
                    : isModel3d
                        ? <Box size={14} className="text-primary" />
                        : isVideo
                            ? <VideoIcon size={14} className="text-primary" />
                            : <ImageIcon size={14} className="text-primary" />}
                <span>{label}</span>
                {isImage && (
                    <span className="text-[10px] text-muted font-normal">
                        {maxLong === maxShort
                            ? `— downsized to ≤${maxLong}px on the long edge before upload`
                            : `— downsized to fit ${maxLong}×${maxShort} (either orientation) before upload`}
                    </span>
                )}
            </label>
            <div
                className={`relative border-2 border-dashed rounded-xl p-3 transition-colors ${
                    dragActive
                        ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                        : preview ? 'border-primary/50 bg-primary/5' : 'border-border bg-surface/30'
                }`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {preview ? (
                    isModel3d ? (
                        <div className="flex items-center gap-3 p-1">
                            <Box size={20} className="text-primary shrink-0" />
                            <span className="flex-1 min-w-0 truncate text-xs text-slate-300"
                                  title={recalledName || pickedName}>
                                {recalledName || pickedName || '3D model ready'}
                            </span>
                            {recalledName && (
                                <span className="text-[9px] font-semibold text-primary inline-flex items-center gap-1 shrink-0" title={recalledName}>
                                    <RotateCw size={10} /> Reused
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={() => { setError(''); setPickedName(''); onRemove(); }}
                                className="p-1.5 rounded-full bg-danger text-on-primary hover:scale-110 transition-transform shrink-0"
                                title="Remove and pick another"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    ) : isAudio ? (
                        <div className="flex items-center gap-3 p-1">
                            <Music size={20} className="text-primary shrink-0" />
                            <audio src={preview} controls className="flex-1 min-w-0 h-9" />
                            {recalledName && (
                                <span className="text-[9px] font-semibold text-primary inline-flex items-center gap-1 shrink-0" title={recalledName}>
                                    <RotateCw size={10} /> Reused
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={() => { setError(''); onRemove(); }}
                                className="p-1.5 rounded-full bg-danger text-on-primary hover:scale-110 transition-transform shrink-0"
                                title="Remove and pick another"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    ) : (
                        <div className="relative aspect-video rounded-lg overflow-hidden group/preview">
                            {recalledName && (
                                <span className="absolute top-1.5 left-1.5 z-10 px-1.5 py-0.5 rounded-md bg-primary/90 text-on-primary text-[9px] font-semibold inline-flex items-center gap-1" title={recalledName}>
                                    <RotateCw size={9} /> Reused
                                </span>
                            )}
                            {isVideo ? (
                                <video src={preview} className="w-full h-full object-cover" muted loop autoPlay playsInline />
                            ) : (
                                <img src={preview} alt="Preview" className="w-full h-full object-cover" />
                            )}
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/preview:opacity-100 transition-opacity flex items-center justify-center">
                                <button
                                    type="button"
                                    onClick={() => { setError(''); onRemove(); }}
                                    className="p-2 rounded-full bg-danger text-on-primary hover:scale-110 transition-transform"
                                    title="Remove and pick another"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                        </div>
                    )
                ) : (
                    <label
                        className={`group flex flex-col items-center justify-center gap-2 py-6 px-2 rounded-lg border border-border bg-background/30 cursor-pointer hover:border-primary/40 hover:bg-surface/60 transition-colors ${processing ? 'opacity-50 pointer-events-none' : ''}`}
                    >
                        <div className="p-2 rounded-full bg-surface border border-border group-hover:border-primary/30 group-hover:scale-105 transition-all">
                            {processing
                                ? <Loader2 size={20} className="text-primary animate-spin" />
                                : <Upload size={20} className="text-muted group-hover:text-primary" />}
                        </div>
                        <span className="text-xs font-medium text-slate-300">
                            {processing
                                ? 'Processing…'
                                : dragActive
                                    ? `Drop ${noun} to upload`
                                    : `Upload ${noun}`}
                        </span>
                        <span className="text-[10px] text-muted">click to browse or drag &amp; drop</span>
                        <input
                            ref={fileInputRef}
                            type="file"
                            className="hidden"
                            accept={acceptAttr}
                            onChange={(e) => handleFile(e.target.files?.[0])}
                        />
                    </label>
                )}
            </div>
            {error && (
                <div className="flex items-start gap-2 text-danger text-xs font-medium bg-danger/10 p-2.5 rounded-lg border border-danger/20">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>{error}</span>
                </div>
            )}
        </div>
    );
};

export default MediaCaptureField;
