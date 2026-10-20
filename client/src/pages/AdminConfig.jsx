import React, { useState, useEffect } from 'react';
import { Power, Save, ArrowLeft, Upload, RefreshCw, Settings, KeyRound, CheckCircle2, AlertTriangle, Pencil, Trash2, OctagonAlert, ShieldCheck, XCircle, RotateCcw, Eraser, History, Server, Globe, Square, HardDrive, ScanSearch, Lock, LockOpen, Gauge, Clapperboard, ListChecks, Sparkles, Wrench } from 'lucide-react';
import WorkflowSelector from '../components/WorkflowSelector';
import WorkflowMetaEditor from '../components/admin/WorkflowMetaEditor';
import StoryboardUpload from '../components/admin/StoryboardUpload';
import RunningWorkflows from '../components/admin/RunningWorkflows';
import ModelPrune from '../components/admin/ModelPrune';
import ModelDownloads from '../components/admin/ModelDownloads';
import MaintenanceScripts from '../components/admin/MaintenanceScripts';
import LibrarySweep from '../components/admin/LibrarySweep';
import ModelQuarantine from '../components/admin/ModelQuarantine';
import VolumePods from '../components/admin/VolumePods';
import NodePacks from '../components/admin/NodePacks';
import InstallUpdates from '../components/admin/InstallUpdates';
import ActivateProgress from '../components/admin/ActivateProgress';
import Modal from '../components/ui/Modal';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ThemeToggle from '../components/ui/ThemeToggle';
import { SERVER_URL } from '../utils/api';
import { useComfyOpener } from '../hooks/useComfyOpener';

// The admin panel's four jobs, in the order an admin needs them: what this
// machine runs, then the server itself, then the ComfyUI behind it, then upkeep.
const ADMIN_TABS = [
    { key: 'workflows', label: 'Workflows', icon: Sparkles },
    { key: 'server', label: 'Manage server', icon: ShieldCheck },
    { key: 'comfyui', label: 'Manage ComfyUI', icon: Server },
    { key: 'maintenance', label: 'Maintenance', icon: Wrench },
];

const PRESET_PYTHON_HINTS = [
    { label: 'Portable (Windows)', value: '../python_embeded/python.exe' },
    { label: 'System Python (POSIX)', value: 'python3' },
    { label: 'System Python (Windows)', value: 'python' }
];

const AdminConfig = ({ currentMode }) => {
    // Which tab is open. Remembered because activating a workflow restarts the
    // server, and an admin thrown back to the first tab every time would curse us.
    const [tab, setTab] = useState(() => {
        try { return localStorage.getItem('comfyq.adminTab') || 'workflows'; }
        catch { return 'workflows'; }
    });
    const selectTab = (key) => {
        setTab(key);
        try { localStorage.setItem('comfyq.adminTab', key); } catch { /* private window */ }
    };
    const [config, setConfig] = useState(null);
    const [hasAdminPassword, setHasAdminPassword] = useState(false);
    const [loading, setLoading] = useState(true);
    const [pathDraft, setPathDraft] = useState({});
    const [pickedWorkflow, setPickedWorkflow] = useState(null);
    const [activatingId, setActivatingId] = useState(null);
    // A workflow whose missing models are being downloaded before it serves.
    const [fetching, setFetching] = useState(null);   // { workflowId, missing }
    const [deactivating, setDeactivating] = useState(false);
    // Set when Stop serving was pressed with jobs on the machine: { running, queued }
    // (null counts = the queue could not be read). Null = no window open.
    const [stopConfirm, setStopConfirm] = useState(null);
    // Workflows being served in parallel, and whether each other workflow would
    // fit alongside them on this machine's card.
    const [lanes, setLanes] = useState([]);
    const [laneFit, setLaneFit] = useState({});
    const [laneCard, setLaneCard] = useState(null);
    const [serveAlongsideId, setServeAlongsideId] = useState(null);
    const [closingLaneId, setClosingLaneId] = useState(null);
    const [adminPassword, setAdminPassword] = useState('');
    const [passwordValid, setPasswordValid] = useState(false);
    const [newAdminPassword, setNewAdminPassword] = useState('');
    const [pwSaving, setPwSaving] = useState(false);
    // Student access password — gates who may USE this machine (see below).
    const [hasAccessPassword, setHasAccessPassword] = useState(false);
    const [hasHfToken, setHasHfToken] = useState(false);
    const [newAccessPassword, setNewAccessPassword] = useState('');
    const [accessSaving, setAccessSaving] = useState(false);
    const [toast, setToast] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [editingWorkflowId, setEditingWorkflowId] = useState(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [deletingWorkflowId, setDeletingWorkflowId] = useState(null);
    // Experimental → validated sign-off: the id awaiting confirmation, and the
    // id whose request is in flight.
    const [confirmValidateId, setConfirmValidateId] = useState(null);
    const [validatingId, setValidatingId] = useState(null);
    const [calibratingIds, setCalibratingIds] = useState(new Set());
    const [showEmergencyConfirm, setShowEmergencyConfirm] = useState(false);
    const [emergencyStopping, setEmergencyStopping] = useState(false);
    const [pathChecks, setPathChecks] = useState(null);
    // Bundle dropdown options vs. the nodes actually installed on this rig.
    const [optionChecks, setOptionChecks] = useState(null);
    const [checkingOptions, setCheckingOptions] = useState(false);
    const [checkingPaths, setCheckingPaths] = useState(false);
    const [drives, setDrives] = useState([]); // mounted Windows drive letters
    const [detecting, setDetecting] = useState(false);
    const [comfyStatus, setComfyStatus] = useState(null);
    // Which bundles want a node pack this machine does not have. Fetched once:
    // a missing pack is a property of the install, not of the page.
    const [nodePackGaps, setNodePackGaps] = useState(null);
    // This machine's label on the LAN (fleet monitor). Draft + saving flag.
    const [machineName, setMachineName] = useState('');
    const [scanDirs, setScanDirs] = useState([]);
    const [savingScanDirs, setSavingScanDirs] = useState(false);
    // The HF token is write-only: the server reports whether one is set, never
    // what it is, so the draft starts empty even when a token is stored.
    const [hfTokenDraft, setHfTokenDraft] = useState('');
    const [savingHfToken, setSavingHfToken] = useState(false);
    const [savingName, setSavingName] = useState(false);
    const [comfyBusy, setComfyBusy] = useState(false);
    const [showTakeoverConfirm, setShowTakeoverConfirm] = useState(false);
    const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
    const [cleaningOutputs, setCleaningOutputs] = useState(false);
    const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
    const [clearingHistory, setClearingHistory] = useState(false);


    // Node-pack gaps, so a card can say a bundle cannot run here.
    useEffect(() => {
        let gone = false;
        (async () => {
            try {
                const res = await fetch(`${SERVER_URL}/admin/nodepacks`);
                const d = await res.json();
                if (!gone) setNodePackGaps(d);
            } catch { /* the Node packs card says so in detail */ }
        })();
        return () => { gone = true; };
    }, [refreshKey]);
    useEffect(() => { reloadConfig(); reloadComfyStatus(); reloadDrives(); }, []);

    // Debounced password verification — hits the no-op /admin/verify-password
    // endpoint whenever the operator pauses typing, so the "Admin password is
    // set" chip can switch green once the correct password is entered. No
    // side effects on the server; never requested when no password is
    // configured (chip isn't rendered in that case).
    useEffect(() => {
        if (!hasAdminPassword || !adminPassword) {
            setPasswordValid(false);
            return;
        }
        let cancelled = false;
        const t = setTimeout(async () => {
            try {
                const res = await fetch(`${SERVER_URL}/admin/verify-password`, {
                    method: 'POST',
                    headers: { 'X-Admin-Password': adminPassword }
                });
                const data = await res.json();
                if (!cancelled) setPasswordValid(!!data.valid);
            } catch {
                if (!cancelled) setPasswordValid(false);
            }
        }, 300);
        return () => { cancelled = true; clearTimeout(t); };
    }, [adminPassword, hasAdminPassword]);

    const reloadConfig = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/config`);
            const data = await res.json();
            setConfig(data.config);
            setHasAdminPassword(data.hasAdminPassword);
            setHasAccessPassword(!!data.hasAccessPassword);
            setHasHfToken(!!data.hasHfToken);
            setPathDraft({
                root_path: data.config.comfy_ui.root_path,
                python_executable: data.config.comfy_ui.python_executable,
                output_dir: data.config.comfy_ui.output_dir,
                api_host: data.config.comfy_ui.api_host,
                api_port: data.config.comfy_ui.api_port,
                installation_type: data.config.comfy_ui.installation_type,
                vramBudgetGb: data.config.comfy_ui.vramBudgetGb,
                assets_dir: data.config.assets?.dir || ''
            });
            setMachineName(data.config.instance?.name || '');
            // Extra workflow folders for the prune scan. Held here, not in
            // ModelPrune, so the Drive letter swap can reach them: an absolute
            // entry is exactly the kind of path a cloned drive invalidates.
            setScanDirs(data.config.maintenance?.workflowScanDirs || []);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const showToast = (msg, kind = 'ok') => {
        setToast({ msg, kind });
        setTimeout(() => setToast(null), 4000);
    };

    // Per-card "Open in ComfyUI" — stages the editable template into ComfyUI's
    // Workflows sidebar (see useComfyOpener); progress/result via the toast.
    const { openingId: openingComfyId, openInComfy } = useComfyOpener({ adminPassword, notify: showToast });

    const adminHeaders = () => {
        const h = { 'Content-Type': 'application/json' };
        if (adminPassword) h['X-Admin-Password'] = adminPassword;
        return h;
    };

    // Its own route, because a token is a credential rather than a setting —
    // adminGate'd, write-only, and an empty string clears it.
    const saveHfToken = async (token, { quiet = false } = {}) => {
        setSavingHfToken(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/hf-token`, {
                method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ token }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            setHasHfToken(!!data.hasHfToken);
            setHfTokenDraft('');
            if (!quiet) showToast(token ? 'HuggingFace token saved' : 'HuggingFace token cleared');
            return true;
        } catch (e) {
            // Never quiet on failure: a credential that silently did not save is
            // the thing this whole change exists to stop.
            showToast(`Could not save the token: ${e.message}`, 'err');
            return false;
        } finally {
            setSavingHfToken(false);
        }
    };

    const saveScanDirs = async (dirs) => {
        setSavingScanDirs(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/maintenance/scan-dirs`, {
                method: 'PUT', headers: adminHeaders(),
                body: JSON.stringify({ workflowScanDirs: dirs })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            setScanDirs(data.workflowScanDirs);
            showToast('Saved the extra workflow folders — rescan to apply them');
            return true;
        } catch (e) {
            showToast(`Could not save: ${e.message}`, 'err');
            return false;
        } finally {
            setSavingScanDirs(false);
        }
    };

    const savePaths = async () => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/comfy`, {
                method: 'PUT', headers: adminHeaders(), body: JSON.stringify(pathDraft)
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to save paths');
            // ★ The scan folders too, or the Drive-letter swap is a lie. That control
            // rewrites them in the form (its own comment says so, because a folder it
            // missed makes that folder's models read as unused) — but they live on
            // another route, so Save settings persisted the four ComfyUI paths and
            // then reloadConfig() pulled the OLD scan dirs straight back over the
            // swapped ones. On a cloned rig that is exactly how you end up pruning
            // against a folder that no longer resolves.
            const stale = JSON.stringify(scanDirs) !== JSON.stringify(config.maintenance?.workflowScanDirs || []);
            if (stale) await saveScanDirs(scanDirs);

            // ★★ The HuggingFace token too, for exactly the reason above it. It sits
            // in this card among the fields this button saves, but it lives on its
            // own adminGate'd route because a credential should not travel through
            // the settings route. The owner typed one in, pressed Save settings,
            // and nothing was stored -- the field LOOKED governed by this button
            // and was not, and the only thing saying otherwise was a comment in
            // the source. The credential still goes through its own route; only
            // the click is shared.
            const pendingToken = hfTokenDraft.trim();
            const tokenSaved = pendingToken ? await saveHfToken(pendingToken, { quiet: true }) : false;

            const parts = ['ComfyUI paths'];
            if (stale) parts.push('scan folders');
            if (tokenSaved) parts.push('HuggingFace token');
            showToast(`${parts.join(', ')} saved`);
            await reloadConfig();
        } catch (e) { showToast(e.message, 'err'); }
    };

    // Rename this machine as it appears in ComfyQ – Discovery. Blank resets to
    // "follow the computer name", which is also what a fresh/re-imaged rig does
    // — that default is what stops a cloned config advertising the old machine's
    // name. Applies live (the next status beacon carries it).
    const saveMachineName = async (nextName) => {
        setSavingName(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/instance`, {
                method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ name: nextName })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to rename this machine');
            setMachineName(data.name || '');
            setConfig(c => ({ ...c, instance: { ...(c?.instance || {}), name: data.name, hostname: data.hostname, nameCustom: data.nameCustom } }));
            showToast(data.nameCustom
                ? `This machine now appears as "${data.name}"`
                : `Following the computer name ("${data.hostname}")`);
        } catch (e) { showToast(e.message, 'err'); }
        finally { setSavingName(false); }
    };

    // Toggle this machine's presence on the LAN status beacon (fleet monitor).
    // Saves immediately and takes effect live (no restart).
    const toggleFederation = async (enabled) => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/federation`, {
                method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ enabled })
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to update network presence');
            setConfig(c => ({ ...c, federation: { ...(c?.federation || {}), enabled } }));
            showToast(enabled ? 'This machine is now visible on the network' : 'This machine is now hidden from the network');
        } catch (e) { showToast(e.message, 'err'); }
    };

    // Toggle whether ComfyUI binds to the LAN (0.0.0.0) so its native web UI is
    // reachable from other machines. Persists immediately; the bind only changes
    // when ComfyUI is (re)started, so pair it with "Restart ComfyUI" below.
    const toggleLanAccess = async (enabled) => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/comfy`, {
                method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ lan_access: enabled })
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to update LAN exposure');
            setConfig(c => ({ ...c, comfy_ui: { ...(c?.comfy_ui || {}), lan_access: enabled } }));
            showToast(enabled
                ? 'ComfyUI will be exposed to the LAN — restart it to apply'
                : 'ComfyUI LAN exposure turned off — restart it to apply');
        } catch (e) { showToast(e.message, 'err'); }
    };

    // Generic toggle for the two ComfyUI performance flags. They apply on the
    // next ComfyUI start/restart (they're part of the spawn signature), so the
    // toast points at Restart rather than pretending it's live.
    const togglePerfFlag = async (key, enabled, label) => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/comfy`, {
                method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ [key]: enabled })
            });
            if (!res.ok) throw new Error((await res.json()).error || `Failed to update ${label}`);
            setConfig(c => ({ ...c, comfy_ui: { ...(c?.comfy_ui || {}), [key]: enabled } }));
            showToast(`${label} ${enabled ? 'enabled' : 'disabled'} — restart ComfyUI to apply`);
        } catch (e) { showToast(e.message, 'err'); }
    };

    const resetPathsToDefaults = async () => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/default-paths`);
            if (!res.ok) throw new Error('Failed to load defaults');
            const defaults = await res.json();
            setPathDraft(prev => ({ ...prev, ...defaults }));
            setPathChecks(null);
            showToast('Form reset to workshop defaults — click Save settings to apply');
        } catch (e) { showToast(e.message, 'err'); }
    };

    const reloadDrives = async () => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/drives`);
            if (res.ok) setDrives((await res.json()).drives || []);
        } catch { /* non-Windows or unreachable — drive picker just hides */ }
    };

    // Rewrite the drive letter on every absolute Windows path in the form at
    // once (root / python / output / assets). Relative paths are left alone.
    const applyDriveLetter = (letter) => {
        if (!letter) return;
        const swap = (p) => (typeof p === 'string' ? p.replace(/^[A-Za-z]:/, `${letter}:`) : p);
        setPathDraft(prev => ({
            ...prev,
            root_path: swap(prev.root_path),
            python_executable: swap(prev.python_executable),
            output_dir: swap(prev.output_dir),
            assets_dir: swap(prev.assets_dir),
        }));
        // ★ The scan folders live outside this form but are absolute Windows
        // paths too, and a folder missed by the swap makes its models look
        // unused — which is what the prune list offers for deletion.
        setScanDirs(prev => prev.map(swap));
        setPathChecks(null);
        showToast(`Switched all absolute paths to ${letter}:\\ — click Save settings to apply`);
    };

    // Ask the server to scan local drives for a ComfyUI install and drop the
    // detected paths into the form.
    const autodetectPaths = async () => {
        setDetecting(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/autodetect-paths`, { method: 'POST', headers: adminHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Auto-detect failed');
            if (!data.found) { showToast('No ComfyUI install found on local drives — set the path manually', 'err'); return; }
            setPathDraft(prev => ({
                ...prev,
                root_path: data.root_path,
                python_executable: data.python_executable,
                output_dir: data.output_dir,
                installation_type: data.installation_type || prev.installation_type,
                ...(data.assets_dir ? { assets_dir: data.assets_dir } : {}),
            }));
            setPathChecks(null);
            showToast(`Found ComfyUI at ${data.root_path} — review and Save settings`);
        } catch (e) { showToast(e.message, 'err'); }
        finally { setDetecting(false); }
    };

    // Compare every workflow's dropdown option lists against the live ComfyUI.
    // A bundle's meta.json can drift from its node, and nothing notices until a
    // job picks a non-default value — at which point ComfyUI rejects the whole
    // prompt. Run this after installing or updating custom nodes.
    const checkWorkflowOptions = async () => {
        setCheckingOptions(true);
        setOptionChecks(null);
        try {
            const res = await fetch(`${SERVER_URL}/admin/workflow-options-check`, { headers: adminHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not check the workflow options');
            setOptionChecks(data);
            showToast(data.stale.length === 0
                ? `${data.checked} dropdown(s) checked — all match this ComfyUI`
                : `${data.stale.length} workflow dropdown(s) don't match this ComfyUI`,
                data.stale.length === 0 ? 'ok' : 'err');
        } catch (e) {
            showToast(e.message, 'err');
        } finally {
            setCheckingOptions(false);
        }
    };

    const checkPaths = async () => {
        setCheckingPaths(true);
        setPathChecks(null);
        try {
            const res = await fetch(`${SERVER_URL}/admin/check-paths`, {
                method: 'POST', headers: adminHeaders(), body: JSON.stringify(pathDraft)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Check failed');
            setPathChecks(data);
            showToast(data.ok ? 'All paths look good' : 'Some paths failed validation', data.ok ? 'ok' : 'err');
        } catch (e) {
            showToast(e.message, 'err');
        } finally {
            setCheckingPaths(false);
        }
    };

    const reloadComfyStatus = async () => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/comfyui/status`);
            if (res.ok) setComfyStatus(await res.json());
        } catch { /* leave previous status */ }
    };

    const launchComfy = async () => {
        setComfyBusy(true);
        try {
            // Persist the current path form first so the backend launches with the
            // paths shown in Settings — not a previously-saved or boot-time value.
            // This launches ComfyUI network-bound, so persist lan_access:true too,
            // keeping the "Expose ComfyUI to the LAN" toggle in sync (so a later
            // Restart, which honors the toggle, stays on the network).
            const saveRes = await fetch(`${SERVER_URL}/admin/comfy`, {
                method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ ...pathDraft, lan_access: true })
            });
            if (!saveRes.ok) throw new Error((await saveRes.json()).error || 'Failed to save paths');
            const res = await fetch(`${SERVER_URL}/admin/comfyui/launch`, { method: 'POST', headers: adminHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Launch failed');
            setComfyStatus(data);
            await reloadConfig();
            showToast(data.external ? 'Attached to a running ComfyUI' : 'ComfyUI launched on the network');
        } catch (e) { showToast(e.message, 'err'); }
        finally { setComfyBusy(false); }
    };

    const restartComfy = async () => {
        setComfyBusy(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/comfyui/restart`, { method: 'POST', headers: adminHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Restart failed');
            setComfyStatus(data);
            await reloadConfig();
            showToast(data.restarted === false
                ? (data.note || 'Left external ComfyUI running')
                : (data.tookOver ? 'Took over & restarted ComfyUI — ComfyQ now manages it' : 'ComfyUI restarted'));
        } catch (e) { showToast(e.message, 'err'); }
        finally { setComfyBusy(false); setShowTakeoverConfirm(false); }
    };

    const stopComfy = async () => {
        setComfyBusy(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/comfyui/stop`, { method: 'POST', headers: adminHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Stop failed');
            setComfyStatus(data);
            showToast(data.stopped === false ? (data.note || 'Left external ComfyUI running') : 'ComfyUI stopped');
        } catch (e) { showToast(e.message, 'err'); }
        finally { setComfyBusy(false); }
    };

    const setPassword = async () => {
        setPwSaving(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/admin-password`, {
                method: 'PUT', headers: adminHeaders(),
                body: JSON.stringify({ password: newAdminPassword })
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to set password');
            showToast(newAdminPassword ? 'Admin password set' : 'Admin password cleared');
            setNewAdminPassword('');
            await reloadConfig();
        } catch (e) {
            showToast(e.message, 'err');
        } finally {
            setPwSaving(false);
        }
    };

    // Set or clear the student access password. Clearing (empty field) reopens
    // the machine to everyone on the LAN.
    const saveAccessPassword = async (explicit) => {
        const value = explicit !== undefined ? explicit : newAccessPassword;
        setAccessSaving(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/access-password`, {
                method: 'PUT', headers: adminHeaders(),
                body: JSON.stringify({ password: value })
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed to set access password');
            showToast(value
                ? 'Access password set — students now need it to connect'
                : 'Access password cleared — this machine is open again');
            setNewAccessPassword('');
            await reloadConfig();
        } catch (e) {
            showToast(e.message, 'err');
        } finally {
            setAccessSaving(false);
        }
    };

    const activate = async (workflowId, { serveWithoutModels = false } = {}) => {
        const id = workflowId || pickedWorkflow?.id;
        if (!id) return;
        setActivatingId(id);
        try {
            const res = await fetch(`${SERVER_URL}/admin/activate-workflow`, {
                method: 'POST', headers: adminHeaders(),
                body: JSON.stringify({ workflowId: id, serveWithoutModels })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to activate');
            // Models missing: the machine downloads them first, then serves.
            if (data.fetching) { setFetching({ workflowId: id, missing: data.missing || [] }); setActivatingId(null); return; }
            showToast(`Activating “${id}” and switching to student mode…`);
            // Server will exit; nodemon will restart. Reload after a moment.
            setTimeout(() => window.location.assign('/user'), 2000);
        } catch (e) {
            showToast(e.message, 'err');
            setActivatingId(null);
        }
    };

    const emergencyStop = async () => {
        setEmergencyStopping(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/emergency-stop`, {
                method: 'POST', headers: adminHeaders()
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Emergency stop failed');
            const parts = [];
            if (data.cancelledScheduled) parts.push(`${data.cancelledScheduled} scheduled cancelled`);
            if (data.failedInFlight) parts.push(`${data.failedInFlight} in-flight failed`);
            if (data.killedComfy) parts.push('ComfyUI killed');
            showToast(`Emergency stop: ${parts.join(', ') || 'no active jobs'} — restarting in admin mode…`);
            setTimeout(() => window.location.reload(), 2500);
        } catch (e) {
            showToast(e.message, 'err');
            setEmergencyStopping(false);
            setShowEmergencyConfirm(false);
        }
    };

    const cleanupOutputs = async () => {
        setCleaningOutputs(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/cleanup-outputs`, {
                method: 'POST', headers: adminHeaders()
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Cleanup failed');
            const errs = data.errors?.length ? `, ${data.errors.length} error(s)` : '';
            const skipped = data.skippedInFlight ? `, ${data.skippedInFlight} in-flight skipped` : '';
            showToast(`Cleaned ${data.filesDeleted} file(s) across ${data.jobsCleared} job(s)${skipped}${errs}`);
            setShowCleanupConfirm(false);
        } catch (e) {
            showToast(e.message, 'err');
        } finally {
            setCleaningOutputs(false);
        }
    };

    const clearHistory = async () => {
        setClearingHistory(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/clear-history`, {
                method: 'POST', headers: adminHeaders()
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Clear history failed');
            const files = data.filesDeleted ? `, ${data.filesDeleted} file(s) removed` : '';
            const errs = data.errors?.length ? `, ${data.errors.length} error(s)` : '';
            showToast(`Deleted ${data.jobsDeleted} job record(s)${files}${errs}`);
            setShowClearHistoryConfirm(false);
        } catch (e) {
            showToast(e.message, 'err');
        } finally {
            setClearingHistory(false);
        }
    };

    // Stop serving the active workflow: flip the server back to admin mode (so
    // students can no longer book) and restart. Surfaced both as the header
    // button and as a per-card "Stop serving" button on the serving workflow.
    // ---- Lanes --------------------------------------------------------------
    // The machine can serve several workflows at once, each on its own ComfyUI.
    // Unlike "Activate & serve", adding one does NOT restart the server, so
    // students already booking are not interrupted.
    const refreshLanes = React.useCallback(async () => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/lanes`, { headers: adminHeaders() });
            if (!res.ok) return;
            const data = await res.json();
            setLanes(data.lanes || []);
            setLaneFit(data.fit || {});
            setLaneCard(data.card || null);
        } catch { /* the panel still works without lane info */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        refreshLanes();
        // A lane's ComfyUI takes a while to come up, and one may be generating —
        // keep the cards and the VRAM verdicts current while the panel is open.
        const t = setInterval(refreshLanes, 5000);
        return () => clearInterval(t);
    }, [refreshLanes]);

    const serveAlongside = async (workflowId, { serveWithoutModels } = {}) => {
        setServeAlongsideId(workflowId);
        showToast('Starting a second ComfyUI for this workflow — this takes a minute…');
        try {
            const res = await fetch(`${SERVER_URL}/admin/lanes`, {
                method: 'POST', headers: adminHeaders(),
                body: JSON.stringify({ workflowId, serveWithoutModels })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || 'Could not start the lane');
            // Models missing: the machine downloads them first, then opens the lane.
            if (body.fetching) { setFetching({ workflowId, missing: body.missing || [], lane: true }); return; }
            showToast(`Now serving “${body.lane?.name || workflowId}” in parallel on port ${body.lane?.port}.`);
        } catch (e) {
            showToast(e.message, 'err');
        } finally {
            setServeAlongsideId(null);
            refreshLanes();
        }
    };

    const closeLane = async (workflowId) => {
        setClosingLaneId(workflowId);
        try {
            const res = await fetch(`${SERVER_URL}/admin/lanes/${encodeURIComponent(workflowId)}`, {
                method: 'DELETE', headers: adminHeaders()
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not stop the lane');
            showToast('Lane stopped — its VRAM is free again.');
        } catch (e) { showToast(e.message, 'err'); }
        finally { setClosingLaneId(null); refreshLanes(); }
    };

    // ★ Stop serving restarts ComfyQ into admin mode: EVERY lane stops, the job
    // rendering fails (server-restart) and the queue waits until the machine
    // serves again. On the Thunder test (2026-10-20) it was pressed on the
    // primary lane mid-class and took the other workflow's render with it. So
    // look at the queue first and ask when there is anything in it.
    const requestStopServing = async () => {
        let counts;
        try {
            const count = async (status) => {
                const r = await fetch(`${SERVER_URL}/jobs?status=${status}`, { headers: adminHeaders() });
                if (!r.ok) throw new Error(String(r.status));
                return ((await r.json()).jobs || []).length;
            };
            const [running, queued] = await Promise.all([count('processing'), count('scheduled')]);
            counts = { running, queued };
        } catch { counts = { running: null, queued: null }; }
        if (counts.running === 0 && counts.queued === 0) return resetToAdmin();
        setStopConfirm(counts);
    };

    const resetToAdmin = async () => {
        setStopConfirm(null);
        setDeactivating(true);
        try {
            const res = await fetch(`${SERVER_URL}/admin/reset-to-admin`, {
                method: 'POST', headers: adminHeaders()
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed');
            showToast('Stopped serving — switching to admin mode…');
            setTimeout(() => window.location.reload(), 2000);
        } catch (e) { showToast(e.message, 'err'); setDeactivating(false); }
    };

    const calibrateWorkflow = async (id) => {
        setCalibratingIds(prev => new Set(prev).add(id));
        try {
            const res = await fetch(`${SERVER_URL}/workflows/${id}/calibrate`, {
                method: 'POST', headers: adminHeaders()
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Calibration failed');
            const r = data.runtime || {};
            const cold = r.coldDurationSec ?? null;
            showToast(`Calibrated "${id}": ~${r.estimatedDurationSec}s generation${cold ? ` · first run ~${cold}s (incl. ~${r.modelLoadSec}s model load)` : ''}`);
            setRefreshKey(k => k + 1);
        } catch (err) {
            showToast(err.message, 'err');
        } finally {
            setCalibratingIds(prev => { const next = new Set(prev); next.delete(id); return next; });
        }
    };

    // Clear a workflow's experimental flag once the admin has tested it by hand.
    // The server rewrites the key in meta.json, so the sign-off is committed with
    // the bundle rather than kept as a per-machine override.
    const validateWorkflow = async (id) => {
        setValidatingId(id);
        try {
            const res = await fetch(`${SERVER_URL}/admin/workflows/${id}/experimental`, {
                method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ experimental: false })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Validation failed');
            showToast(`"${id}" validated — no longer experimental`);
            setRefreshKey(k => k + 1);
        } catch (err) {
            showToast(err.message, 'err');
        } finally {
            setValidatingId(null);
            setConfirmValidateId(null);
        }
    };

    const deleteWorkflow = async (id) => {
        try {
            const res = await fetch(`${SERVER_URL}/admin/workflows/${id}`, {
                method: 'DELETE', headers: adminHeaders()
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Delete failed');
            showToast(`Workflow "${id}" deleted`);
            setRefreshKey(k => k + 1);
            setPickedWorkflow(prev => (prev?.id === id ? null : prev));
        } catch (err) {
            showToast(err.message, 'err');
        } finally {
            setDeletingWorkflowId(null);
        }
    };

    const uploadWorkflow = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        try {
            const fd = new FormData();
            fd.append('workflow', file);
            const headers = {};
            if (adminPassword) headers['X-Admin-Password'] = adminPassword;
            const res = await fetch(`${SERVER_URL}/admin/upload-workflow`, {
                method: 'POST', headers, body: fd
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');
            showToast(`Workflow "${data.id}" registered (${data.parameterCount} parameters detected)`);
            await fetch(`${SERVER_URL}/workflows/refresh`, { method: 'POST' });
            setEditingWorkflowId(data.id);
        } catch (err) { showToast(err.message, 'err'); }
        finally { setUploading(false); e.target.value = ''; }
    };

    if (loading) {
        return (
            <div className="h-screen w-full bg-background flex items-center justify-center">
                <RefreshCw className="w-6 h-6 text-primary animate-spin" />
            </div>
        );
    }

    const pathsConfigured = !!(config?.comfy_ui?.root_path && config?.comfy_ui?.python_executable);
    const currentDrive = (pathDraft.root_path || '').match(/^([A-Za-z]):/)?.[1]?.toUpperCase() || '';
    // Always include the currently-configured drive even if it isn't mounted now.
    const driveOptions = Array.from(new Set([currentDrive, ...drives].filter(Boolean)));

    return (
        <div className="min-h-screen bg-background text-foreground p-4 sm:p-8 space-y-6">
            <header className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-surface border border-border rounded-xl flex items-center justify-center">
                        <Settings className="w-5 h-5 text-muted" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">ComfyQ Admin</h1>
                        <p className="text-xs text-muted">Server is in <Badge variant={config.mode === 'student' ? 'success' : 'warning'}>{config.mode}</Badge> mode</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <ThemeToggle />
                    {config.mode === 'student' && (
                        <Button variant="ghost" onClick={() => window.location.assign('/user')} icon={ArrowLeft}>Back to user</Button>
                    )}
                    {config.mode === 'student' && (
                        <Button variant="secondary" onClick={requestStopServing} icon={Power}>Reset to admin</Button>
                    )}
                    {config.mode === 'student' && (
                        <Button variant="danger" onClick={() => setShowEmergencyConfirm(true)} icon={OctagonAlert}>
                            Stop &amp; kill all
                        </Button>
                    )}
                </div>
            </header>

            {/* One tab at a time. The page had grown to ten stacked cards, which
                buried the workflow library under server administration. */}
            <nav className="flex items-center gap-1 flex-wrap border-b border-border">
                {ADMIN_TABS.map(t => {
                    const Icon = t.icon;
                    const on = tab === t.key;
                    return (
                        <button key={t.key} type="button" onClick={() => selectTab(t.key)}
                            className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 transition-colors
                                ${on ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-foreground'}`}>
                            <Icon size={15} />{t.label}
                        </button>
                    );
                })}
            </nav>


            {toast && (
                <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 ${toast.kind === 'err' ? 'bg-danger/20 text-danger border border-danger/30' : 'bg-primary/20 text-primary border border-primary/30'}`}>
                    {toast.kind === 'err' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
                    {toast.msg}
                </div>
            )}

            {hasAdminPassword && (
                <Card className={passwordValid ? 'border-success/40' : 'border-warning/30'}>
                    <div className={`flex items-center gap-2 mb-2 ${passwordValid ? 'text-success' : 'text-warning'}`}>
                        {passwordValid ? <CheckCircle2 size={16} /> : <KeyRound size={16} />}
                        <span className="font-medium">
                            {passwordValid ? 'Admin password verified' : 'Admin password is set'}
                        </span>
                    </div>
                    <p className="text-xs text-muted mb-3">
                        {passwordValid
                            ? 'You can perform destructive actions below.'
                            : 'Provide the password to make changes below.'}
                    </p>
                    <input
                        type="password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        placeholder="Admin password"
                        className={`w-full bg-background border rounded-lg p-2.5 text-white transition-colors ${passwordValid ? 'border-success/50 focus:border-success' : 'border-border'}`}
                    />
                </Card>
            )}






            {tab === 'workflows' && (
                <>
                    <RunningWorkflows
                        lanes={lanes}
                        card={laneCard}
                        serving={config.mode === 'student'}
                        onCloseLane={closeLane}
                        closingLaneId={closingLaneId}
                        onDeactivate={requestStopServing}
                        deactivating={deactivating}
                    />
                <Card>
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold">Workflow library</h2>
                        {config.workflows.activeWorkflowId && (
                            <Badge variant="primary">Active: {config.workflows.activeWorkflowId}</Badge>
                        )}
                    </div>
                    <WorkflowSelector
                        key={refreshKey}
                        headers={adminHeaders()}
                        nodePackGaps={nodePackGaps}
                        selectedWorkflowId={config.workflows.activeWorkflowId}
                        activeWorkflowId={config.workflows.activeWorkflowId}
                        onSelect={(w) => setPickedWorkflow(w)}
                        onEdit={(id) => setEditingWorkflowId(id)}
                        onDelete={(id) => setDeletingWorkflowId(id)}
                        onCalibrate={(id) => calibrateWorkflow(id)}
                        calibratingIds={calibratingIds}
                        onOpenInComfy={openInComfy}
                        openingComfyId={openingComfyId}
                        onActivate={(id) => activate(id)}
                        activatingId={activatingId}
                        canActivate={pathsConfigured}
                        onDeactivate={requestStopServing}
                        deactivating={deactivating}
                        serving={config.mode === 'student'}
                        onValidate={(id) => setConfirmValidateId(id)}
                        validatingId={validatingId}
                        lanes={lanes}
                        laneFit={laneFit}
                        onServeAlongside={serveAlongside}
                        serveAlongsideId={serveAlongsideId}
                        onCloseLane={closeLane}
                        closingLaneId={closingLaneId}
                    />
                    <div className="mt-6 flex items-center justify-end gap-2 flex-wrap">
                        {pickedWorkflow && <span className="text-xs text-muted mr-auto">Selected: <code>{pickedWorkflow.id}</code></span>}
                        <Button variant="secondary" icon={Pencil}
                            disabled={!pickedWorkflow}
                            onClick={() => pickedWorkflow && setEditingWorkflowId(pickedWorkflow.id)}>
                            Edit metadata
                        </Button>
                        <Button variant="primary" icon={Power}
                            disabled={!pickedWorkflow || activatingId !== null || !pathsConfigured}
                            onClick={() => activate(pickedWorkflow?.id)}>
                            {activatingId !== null ? 'Activating…' : 'Activate & start student mode'}
                        </Button>
                    </div>
                </Card>
                <Card>
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-lg font-semibold flex items-center gap-2">
                            <Clapperboard size={18} /> Storyboard batch
                        </h2>
                        <Badge variant={config?.mode === 'student' ? 'success' : 'default'}>
                            {config?.mode === 'student' ? 'Serving' : 'Idle'}
                        </Badge>
                    </div>
                    <p className="text-xs text-muted mb-3">
                        Upload one markdown storyboard and queue every generation it describes, in the
                        order that makes them possible: all the images first, then the videos that use
                        those images as their frames, then the audio. The document names its own
                        workflows — within each of those three groups the shots are ordered so each
                        model is loaded once, and queueing starts the machine if it is idle.
                    </p>
                    <StoryboardUpload
                        adminPassword={adminPassword}
                        serving={config?.mode === 'student'}
                        notify={showToast}
                    />
                </Card>
                <Card>
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold flex items-center gap-2"><Upload size={18} /> Add Workflow</h2>
                    </div>
                    <p className="text-sm text-muted mb-3">
                        Upload a ComfyUI workflow saved in <strong className="text-white">API Format</strong>
                        (Settings → Dev mode → "Save (API Format)"). v2 does not auto-convert standard saves.
                    </p>
                    <label className="block">
                        <input type="file" accept=".json,application/json" onChange={uploadWorkflow}
                            disabled={uploading}
                            className="block w-full text-sm text-muted file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-primary/10 file:text-primary hover:file:bg-primary/20" />
                    </label>
                </Card>
                </>
            )}

            {tab === 'server' && (
                <>
                <Card>
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-lg font-semibold flex items-center gap-2">
                            {hasAccessPassword ? <Lock size={18} /> : <LockOpen size={18} />} Student access
                        </h2>
                        <Badge variant={hasAccessPassword ? 'success' : 'default'}>
                            {hasAccessPassword ? 'Password required' : 'Open to everyone'}
                        </Badge>
                    </div>
                    <p className="text-xs text-muted mb-3">
                        {hasAccessPassword
                            ? 'Students must enter this password before they can connect to this machine and book jobs. Type a new one to change it, or clear it to reopen the machine.'
                            : 'Anyone on the network can use this machine. Set a password to reserve it for one group — they will be asked for it when they open the student page.'}
                    </p>
                    <div className="flex items-center gap-2">
                        <input type="password" value={newAccessPassword}
                            onChange={(e) => setNewAccessPassword(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && newAccessPassword) saveAccessPassword(); }}
                            placeholder={hasAccessPassword ? 'New access password' : 'Access password for students'}
                            className="flex-1 bg-background border border-border rounded-lg p-2.5 text-white" />
                        <Button variant="primary" onClick={() => saveAccessPassword()}
                            disabled={accessSaving || !newAccessPassword}>
                            {accessSaving ? 'Saving…' : hasAccessPassword ? 'Change' : 'Lock machine'}
                        </Button>
                        {hasAccessPassword && (
                            <Button variant="secondary" icon={LockOpen} onClick={() => saveAccessPassword('')}
                                disabled={accessSaving}>
                                Remove
                            </Button>
                        )}
                    </div>
                    {hasAccessPassword && (
                        <p className="text-[11px] text-muted mt-2">
                            Changing or removing the password disconnects anyone already connected with the old one.
                        </p>
                    )}
                </Card>
                <Card>
                    <h2 className="text-lg font-semibold flex items-center gap-2 mb-3"><KeyRound size={18} /> Admin password</h2>
                    <p className="text-xs text-muted mb-3">
                        {hasAdminPassword
                            ? 'A password is set. Enter the current password above, then enter a new one (or leave blank to disable).'
                            : 'No password set yet. Anyone with access to /admin can change settings. Set one to gate destructive actions.'}
                    </p>
                    <div className="flex items-center gap-2">
                        <input type="password" value={newAdminPassword}
                            onChange={(e) => setNewAdminPassword(e.target.value)}
                            placeholder="New admin password (blank to clear)"
                            className="flex-1 bg-background border border-border rounded-lg p-2.5 text-white" />
                        <Button variant="primary" onClick={setPassword} disabled={pwSaving}>
                            {pwSaving ? 'Saving…' : 'Save'}
                        </Button>
                    </div>
                </Card>
                <Card>
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-lg font-semibold flex items-center gap-2"><Globe size={18} /> Network presence</h2>
                        {(config?.federation?.enabled !== false)
                            ? <Badge variant="success">Visible</Badge>
                            : <Badge variant="warning">Hidden</Badge>}
                    </div>
                    <p className="text-sm text-muted mb-3">
                        When on, this machine broadcasts a small status update on the LAN every ~15&nbsp;s so the
                        <strong className="text-white"> ComfyQ Discovery</strong> app can list it (name, GPU/RAM, IP, status,
                        active workflow, planned jobs) alongside the other rigs. Turn off to hide this machine from the network.
                    </p>

                    {/* Machine name — what identifies this rig in Discovery, so an
                        admin can tell at a glance which machine runs which workflow. */}
                    <div className="mb-4 p-3 rounded-xl bg-surface border border-border space-y-2">
                        <label className="text-[10px] uppercase tracking-wider text-muted font-semibold flex items-center gap-1.5">
                            <HardDrive size={12} /> This machine is called
                        </label>
                        <div className="flex flex-wrap gap-2">
                            <input
                                type="text"
                                value={machineName}
                                onChange={(e) => setMachineName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveMachineName(machineName); }}
                                placeholder={config?.instance?.hostname || 'Computer name'}
                                maxLength={64}
                                className="flex-1 min-w-[12rem] px-3 py-2 rounded-lg bg-background border border-border text-sm text-foreground focus:outline-none focus:border-primary"
                            />
                            <Button variant="primary" icon={Save} onClick={() => saveMachineName(machineName)} disabled={savingName}>
                                {savingName ? 'Saving…' : 'Save name'}
                            </Button>
                            {config?.instance?.nameCustom && (
                                <Button variant="secondary" icon={RotateCcw} onClick={() => saveMachineName('')} disabled={savingName}
                                    title="Go back to following this computer's name">
                                    Use computer name
                                </Button>
                            )}
                        </div>
                        <p className="text-xs text-muted">
                            {config?.instance?.nameCustom
                                ? <>Custom name — it stays put. This computer is <code className="text-foreground">{config?.instance?.hostname}</code>.</>
                                : <>Following this computer's name (<code className="text-foreground">{config?.instance?.hostname}</code>). Give it a room label like <em>Poste&nbsp;3</em> to make it obvious in Discovery.</>}
                        </p>
                    </div>
                    <label className="flex items-start gap-2.5 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={config?.federation?.enabled !== false}
                            onChange={(e) => toggleFederation(e.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                        />
                        <span className="text-sm text-white">
                            Show this machine on the network
                            <span className="block text-xs text-muted">
                                Takes effect immediately — no restart. Read-only broadcast (status only); it never lets
                                another machine control this one.
                            </span>
                        </span>
                    </label>
                </Card>
                <Card>
                    <h2 className="text-lg font-semibold flex items-center gap-2 mb-3"><Eraser size={18} /> Cleanup</h2>
                    <p className="text-xs text-muted mb-3">
                        Delete every output file referenced by completed jobs and clear the outputs from each job record.
                        Job history (prompts, timestamps, users) is preserved — only the rendered images / videos are removed from disk.
                    </p>
                    <div className="flex justify-end">
                        <Button variant="danger" icon={Eraser} onClick={() => setShowCleanupConfirm(true)}>
                            Clean all outputs
                        </Button>
                    </div>
                </Card>
                <Card>
                    <h2 className="text-lg font-semibold flex items-center gap-2 mb-3"><History size={18} /> Clear job history</h2>
                    <p className="text-xs text-muted mb-3">
                        Permanently delete all finished job records (completed, failed, cancelled) and their event logs, plus any output files they reference.
                        Scheduled and in-flight jobs are kept so a running queue isn't interrupted.
                    </p>
                    <div className="flex justify-end">
                        <Button variant="danger" icon={Trash2} onClick={() => setShowClearHistoryConfirm(true)}>
                            Clear all history
                        </Button>
                    </div>
                </Card>
                </>
            )}

            {tab === 'comfyui' && (
                <>
                <Card>
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold flex items-center gap-2"><Settings size={18} /> ComfyUI Settings</h2>
                        {pathsConfigured && <Badge variant="success">Configured</Badge>}
                    </div>
                    {driveOptions.length > 0 && (
                        <div className="mb-4 flex items-center gap-2 flex-wrap rounded-lg border border-border bg-surface/40 p-3">
                            <HardDrive size={16} className="text-primary shrink-0" />
                            <span className="text-sm font-medium">Drive letter</span>
                            <select
                                value={currentDrive}
                                onChange={(e) => applyDriveLetter(e.target.value)}
                                className="bg-background border border-border rounded-md px-2 py-1.5 text-sm text-white"
                            >
                                {driveOptions.map(d => <option key={d} value={d}>{d}:\</option>)}
                            </select>
                            <span className="text-xs text-muted">Swaps the drive on every absolute path below at once — handy when this machine cloned the drive to a different letter.</span>
                        </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Field label="ComfyUI root path" value={pathDraft.root_path || ''}
                            onChange={v => setPathDraft({ ...pathDraft, root_path: v })}
                            placeholder="C:\\Apps\\AI\\ComfyUI_portable\\ComfyUI" />
                        <Field label="Python executable" value={pathDraft.python_executable || ''}
                            onChange={v => setPathDraft({ ...pathDraft, python_executable: v })}
                            placeholder="../python_embeded/python.exe">
                            <div className="flex gap-1 mt-1">
                                {PRESET_PYTHON_HINTS.map(p => (
                                    <button key={p.value} type="button"
                                        onClick={() => setPathDraft({ ...pathDraft, python_executable: p.value })}
                                        className="text-[10px] px-2 py-0.5 bg-surface border border-border rounded hover:border-primary/50 text-muted">
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        </Field>
                        <Field label="Output directory" value={pathDraft.output_dir || ''}
                            onChange={v => setPathDraft({ ...pathDraft, output_dir: v })}
                            placeholder="output" />
                        <Field label="VRAM budget (GB)" type="number" value={pathDraft.vramBudgetGb || 24}
                            onChange={v => setPathDraft({ ...pathDraft, vramBudgetGb: parseFloat(v) })} />
                        <Field label="ComfyUI API host" value={pathDraft.api_host || '127.0.0.1'}
                            onChange={v => setPathDraft({ ...pathDraft, api_host: v })} />
                        <Field label="ComfyUI API port" type="number" value={pathDraft.api_port || 8188}
                            onChange={v => setPathDraft({ ...pathDraft, api_port: parseInt(v, 10) })} />
                        <div className="space-y-1.5 sm:col-span-2">
                            <label className="text-xs uppercase tracking-wider text-muted font-semibold">Assets directory (calibration media)</label>
                            <input
                                type="text"
                                value={pathDraft.assets_dir || ''}
                                onChange={(e) => setPathDraft({ ...pathDraft, assets_dir: e.target.value })}
                                placeholder="G:\\_assets"
                                className="w-full bg-background border border-border rounded-lg p-2.5 text-white font-mono text-sm"
                            />
                            <p className="text-[11px] text-muted">
                                Folder of sample images / videos / audio used to auto-calibrate workflow timing. Update this if the drive letter changes (e.g. <code>D:\_assets</code> → <code>G:\_assets</code>). Leave blank to fall back to a built-in image — video/audio workflows then can't auto-calibrate. Use <strong>Check paths</strong> to confirm the folder exists and has media.
                            </p>
                        </div>

                        {/* ★ A credential, so it goes through its own adminGate'd route
                            and is never read back — the server reports only whether one is
                            set. Eight of this library's model links answer 401 without one
                            (FLUX.2, LTX-2.5). ★★ It has its own Save button AND is saved by
                            "Save settings": it used to be only the former, and a field
                            sitting among this card's fields while not being saved by this
                            card's button is a control whose behaviour contradicts its
                            appearance. The token was typed, Save settings was pressed, and
                            nothing was stored. */}
                        <div className="space-y-1.5 sm:col-span-2">
                            <label className="text-xs uppercase tracking-wider text-muted font-semibold flex items-center gap-2">
                                <KeyRound size={13} /> HuggingFace access token
                                {hasHfToken
                                    ? <Badge variant="success">set</Badge>
                                    : <Badge variant="default">not set</Badge>}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={hfTokenDraft}
                                    onChange={(e) => setHfTokenDraft(e.target.value)}
                                    placeholder={hasHfToken ? '•••••••• (a token is stored — type a new one to replace it)' : 'hf_…'}
                                    autoComplete="off"
                                    className="flex-1 bg-background border border-border rounded-lg p-2.5 text-white font-mono text-sm"
                                />
                                <Button variant="secondary" disabled={savingHfToken || !hfTokenDraft.trim()}
                                    onClick={() => saveHfToken(hfTokenDraft.trim())}>
                                    {savingHfToken ? 'Saving…' : 'Save token'}
                                </Button>
                                {hasHfToken && (
                                    <Button variant="ghost" disabled={savingHfToken}
                                        onClick={() => saveHfToken('')}>Clear</Button>
                                )}
                            </div>
                            <p className="text-[11px] text-muted">
                                Saved by <strong>Save token</strong> or by <strong>Save settings</strong> —
                                either works. It travels on its own route because it is a credential, not a
                                setting.{' '}
                                Needed only for <strong>gated</strong> repositories, and only for downloading
                                a model — nothing else uses it. Accept the licence on the model's
                                HuggingFace page first, then create a <strong>read</strong> token at{' '}
                                <a className="text-primary hover:underline" target="_blank" rel="noreferrer"
                                    href="https://huggingface.co/settings/tokens">huggingface.co/settings/tokens</a>.
                                It is stored in this machine's <code>config.json</code>, is never sent back to
                                the browser, and is only ever sent to huggingface.co itself.
                            </p>
                        </div>
                    </div>
                    {pathChecks && (
                        <div className="mt-4 rounded-lg border border-border bg-surface/50 p-3 text-sm">
                            <div className={`mb-2 font-medium ${pathChecks.ok ? 'text-success' : 'text-danger'}`}>
                                {pathChecks.ok ? 'All checks passed' : 'Some checks failed'}
                            </div>
                            <ul className="space-y-1">
                                {pathChecks.checks.map((c, i) => (
                                    <li key={i} className="flex items-start gap-2">
                                        {c.ok
                                            ? <CheckCircle2 size={16} className="text-success mt-0.5 shrink-0" />
                                            : <XCircle size={16} className="text-danger mt-0.5 shrink-0" />}
                                        <div className="min-w-0">
                                            <div className="text-white">{c.label}</div>
                                            <div className="text-xs text-muted break-all">{c.detail}</div>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {optionChecks && (
                        <div className="mt-4 rounded-lg border border-border bg-surface/50 p-3 text-sm">
                            <div className={`mb-2 font-medium ${optionChecks.stale.length === 0 ? 'text-success' : 'text-danger'}`}>
                                {optionChecks.stale.length === 0
                                    ? `${optionChecks.checked} dropdown(s) match this ComfyUI`
                                    : `${optionChecks.stale.length} dropdown(s) don't match this ComfyUI`}
                            </div>
                            {optionChecks.stale.map((s, i) => (
                                <div key={i} className="mb-2 flex items-start gap-2">
                                    <XCircle size={16} className="text-danger mt-0.5 shrink-0" />
                                    <div className="min-w-0">
                                        <div className="text-white break-all">{s.workflowId} · {s.field}</div>
                                        {s.bogusOptions.length > 0 && (
                                            <div className="text-xs text-danger/90 break-words">
                                                not offered by {s.classType}: {s.bogusOptions.join(', ')}
                                            </div>
                                        )}
                                        {!s.defaultValid && (
                                            <div className="text-xs text-danger/90 break-words">
                                                its default {JSON.stringify(s.declaredDefault)} is not selectable
                                            </div>
                                        )}
                                        <div className="text-xs text-muted break-words">
                                            this node offers: {s.liveOptions.join(', ')}
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {optionChecks.skipped.length > 0 && (
                                <p className="text-xs text-muted mt-1">
                                    {optionChecks.skipped.length} dropdown(s) could not be checked — their node
                                    doesn't publish a fixed list (a workflow-defined combo), so this is not a
                                    clean bill of health for them.
                                </p>
                            )}
                        </div>
                    )}
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                        <Button variant="ghost" icon={ScanSearch} disabled={detecting} onClick={autodetectPaths}>
                            {detecting ? 'Detecting…' : 'Auto-detect'}
                        </Button>
                        <Button variant="ghost" icon={ListChecks} disabled={checkingOptions}
                            onClick={checkWorkflowOptions}>
                            {checkingOptions ? 'Checking…' : 'Check workflow options'}
                        </Button>
                        <Button variant="ghost" icon={RotateCcw} onClick={resetPathsToDefaults}>
                            Reset to defaults
                        </Button>
                        <Button variant="secondary" icon={ShieldCheck}
                            disabled={checkingPaths}
                            onClick={checkPaths}>
                            {checkingPaths ? 'Checking…' : 'Check paths'}
                        </Button>
                        <Button variant="primary" icon={Save} onClick={savePaths}>Save settings</Button>
                    </div>
                </Card>
                <Card>
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-lg font-semibold flex items-center gap-2"><Server size={18} /> ComfyUI backend</h2>
                        {comfyStatus?.running
                            ? <Badge variant="success">
                                {comfyStatus.studentMode ? 'Running · active workflow'
                                    : comfyStatus.external ? 'Running · external'
                                    : comfyStatus.networkBound ? 'Running · network'
                                    : 'Running · localhost'}
                              </Badge>
                            : <Badge variant="warning">Stopped</Badge>}
                    </div>
                    <p className="text-sm text-muted mb-3">
                        Launch ComfyUI bound to the network (<code>0.0.0.0:{comfyStatus?.port || config?.comfy_ui?.api_port || 8188}</code>) so anyone on the LAN can open its native web UI and run classic workflows on this GPU — no ComfyQ needed. It stays up across calibrations and a later workflow activation attaches to it.
                    </p>

                    <label className="flex items-start gap-2.5 cursor-pointer mb-4">
                        <input
                            type="checkbox"
                            checked={config?.comfy_ui?.lan_access ?? false}
                            onChange={(e) => toggleLanAccess(e.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                        />
                        <span className="text-sm text-white">
                            Expose ComfyUI to the LAN
                            <span className="block text-xs text-muted">
                                Binds ComfyUI to <code>0.0.0.0</code> so people on the network can open its native web UI
                                (<code>http://&lt;this-machine&gt;:{config?.comfy_ui?.api_port || 8188}</code>) and run classic
                                workflows on this GPU. ComfyQ still connects over localhost. Saved immediately; the bind changes
                                when ComfyUI is started or restarted.
                            </span>
                        </span>
                    </label>

                    <div className="mb-4 rounded-lg border border-border bg-surface/40 p-3">
                        <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2 flex items-center gap-1.5">
                            <Gauge size={12} /> Performance (applies on restart)
                        </div>
                        <label className="flex items-start gap-2.5 cursor-pointer mb-2.5">
                            <input
                                type="checkbox"
                                checked={config?.comfy_ui?.use_sage_attention ?? false}
                                onChange={(e) => togglePerfFlag('use_sage_attention', e.target.checked, 'SageAttention')}
                                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                            />
                            <span className="text-sm text-white">
                                SageAttention
                                <span className="block text-xs text-muted">
                                    Adds <code>--use-sage-attention</code>. Replaces the attention kernel for every
                                    workflow — the biggest wins are on video models. Needs the <code>sageattention</code>
                                    package installed in ComfyUI's Python; if it isn't, ComfyUI just falls back to its
                                    default kernel.
                                </span>
                            </span>
                        </label>
                        <label className="flex items-start gap-2.5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={config?.comfy_ui?.fp16_accumulation ?? false}
                                onChange={(e) => togglePerfFlag('fp16_accumulation', e.target.checked, 'fp16 accumulation')}
                                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                            />
                            <span className="text-sm text-white">
                                fp16 accumulation
                                <span className="block text-xs text-muted">
                                    Adds <code>--fast fp16_accumulation</code>. Notable on RTX 40/50-series cards. Only this
                                    one optimisation is passed — never bare <code>--fast</code>, which turns on everything in
                                    ComfyUI's "untested, potentially quality-deteriorating" set.
                                </span>
                            </span>
                        </label>
                        <p className="text-[11px] text-muted mt-2.5">
                            Both are global and off by default. If output quality or stability changes, turn them off and
                            restart to rule them out.
                        </p>
                    </div>

                    {comfyStatus?.studentMode ? (
                        <p className="text-xs text-muted">
                            ComfyUI is currently managed by the active workflow (student mode). <strong className="text-white">Reset to admin</strong> to launch / stop it here.
                        </p>
                    ) : (
                        <>
                            {comfyStatus?.running && (comfyStatus.networkBound || comfyStatus.external) && comfyStatus.urls?.length > 0 && (
                                <div className="mb-3 rounded-lg border border-border bg-surface/50 p-3">
                                    <label className="text-[10px] uppercase tracking-wider text-muted font-semibold flex items-center gap-1.5"><Globe size={12} /> Open ComfyUI at</label>
                                    <ul className="mt-1.5 space-y-1">
                                        {comfyStatus.urls.map(u => (
                                            <li key={u}>
                                                <a href={u} target="_blank" rel="noreferrer" className="text-sm font-mono text-primary hover:underline break-all">{u}</a>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {comfyStatus?.running && !comfyStatus.networkBound && !comfyStatus.external && (
                                <p className="text-[11px] text-warning mb-3">Bound to localhost only (started for calibration). Click <strong>Bind to network</strong> to expose it on the LAN.</p>
                            )}
                            {comfyStatus?.external ? (
                                <>
                                    <p className="text-[11px] text-muted mb-3">
                                        Attached to a ComfyUI started outside ComfyQ. <strong className="text-white">Restart</strong> takes it over — it force-stops that instance and relaunches ComfyUI under ComfyQ, so Restart, Stop and the LAN toggle work here afterward.
                                    </p>
                                    <div className="flex justify-end">
                                        <Button variant="secondary" icon={RefreshCw} onClick={() => setShowTakeoverConfirm(true)} disabled={comfyBusy || !pathsConfigured}>
                                            {comfyBusy ? 'Restarting… (30–90s)' : 'Restart & take over'}
                                        </Button>
                                    </div>
                                </>
                            ) : (
                                <div className="flex justify-end gap-2">
                                    {comfyStatus?.running && (
                                        <Button variant="secondary" icon={RefreshCw} onClick={restartComfy} disabled={comfyBusy}>
                                            {comfyBusy ? 'Working…' : 'Restart ComfyUI'}
                                        </Button>
                                    )}
                                    {comfyStatus?.running && (
                                        <Button variant="secondary" icon={Square} onClick={stopComfy} disabled={comfyBusy}>
                                            {comfyBusy ? 'Working…' : 'Stop ComfyUI'}
                                        </Button>
                                    )}
                                    {!(comfyStatus?.running && comfyStatus?.networkBound) && (
                                        <Button variant="primary" icon={Globe} onClick={launchComfy} disabled={comfyBusy || !pathsConfigured}>
                                            {comfyBusy ? 'Launching… (30–90s)' : comfyStatus?.running ? 'Bind to network' : 'Launch ComfyUI on network'}
                                        </Button>
                                    )}
                                </div>
                            )}
                            {!pathsConfigured && (
                                <p className="text-[11px] text-warning mt-2 text-right">Set the ComfyUI paths above first.</p>
                            )}
                        </>
                    )}
                </Card>

                <NodePacks headers={adminHeaders()} onToast={showToast} />
                </>
            )}

            {tab === 'maintenance' && (
                <>
                    {/* Only on a network volume shared by several Pods: who else is
                        on it, and why pruning is paused while they are. */}
                    <VolumePods />

                    {/* First card in the tab. Updating the install was named as
                        belonging to Maintenance before this tab had anything in
                        it, and it is where the owner went looking for it — it
                        spent one afternoon under Manage ComfyUI and could not be
                        found. */}
                    <InstallUpdates headers={adminHeaders()} onToast={showToast} mode={config.mode} />

                    <ModelDownloads headers={adminHeaders()} onToast={showToast} hasHfToken={hasHfToken} />

                    <ModelPrune headers={adminHeaders()} onToast={showToast}
                        scanDirs={scanDirs} onScanDirsChange={setScanDirs}
                        onSaveScanDirs={saveScanDirs} savingScanDirs={savingScanDirs} />

                    {/* Directly under the prune card: it is the way back from it, and the
                        only place the reclaimed space actually happens. */}
                    <ModelQuarantine headers={adminHeaders()} onToast={showToast} />

                    <LibrarySweep headers={adminHeaders()} onToast={showToast} mode={config.mode} />

                    <MaintenanceScripts headers={adminHeaders()} onToast={showToast} />
                </>
            )}

            <WorkflowMetaEditor
                workflowId={editingWorkflowId}
                adminPassword={adminPassword}
                onClose={() => setEditingWorkflowId(null)}
                onSaved={() => {
                    setRefreshKey(k => k + 1);
                    showToast('Workflow metadata saved');
                }}
            />

            {fetching && (
                <ActivateProgress workflowId={fetching.workflowId} missing={fetching.missing} lane={!!fetching.lane}
                    onClose={() => { setFetching(null); refreshLanes(); }}
                    onServeAnyway={() => {
                        const id = fetching.workflowId, lane = fetching.lane; setFetching(null);
                        if (lane) serveAlongside(id, { serveWithoutModels: true }); else activate(id, { serveWithoutModels: true });
                    }} />
            )}

            <Modal isOpen={!!stopConfirm} onClose={() => !deactivating && setStopConfirm(null)}
                title="Stop serving while jobs are on this machine?" maxWidth="max-w-md">
                {stopConfirm && (
                    <div className="space-y-4">
                        {stopConfirm.running === null ? (
                            <p className="text-sm text-foreground">The queue could not be read, so jobs may be rendering or waiting.</p>
                        ) : (
                            <ul className="text-sm text-foreground space-y-1.5 list-disc pl-5">
                                {stopConfirm.running > 0 && (
                                    <li><b>{stopConfirm.running}</b> job{stopConfirm.running > 1 ? 's' : ''} rendering will <b>fail</b> (<code className="text-xs">server-restart</code>).</li>
                                )}
                                {stopConfirm.queued > 0 && (
                                    <li><b>{stopConfirm.queued}</b> queued job{stopConfirm.queued > 1 ? 's' : ''} will wait until this machine serves again.</li>
                                )}
                            </ul>
                        )}
                        <p className="text-sm text-muted">
                            Stopping does not stop just one model: ComfyQ restarts in admin mode and <b>every workflow on this machine stops</b>.
                            Wait until the queue is empty — or, to drop a second workflow only, use <i>Close lane</i> on it.
                        </p>
                        <div className="flex justify-end gap-2 pt-2 border-t border-border">
                            <Button variant="ghost" onClick={() => setStopConfirm(null)} disabled={deactivating}>Keep serving</Button>
                            <Button variant="danger" icon={Power} onClick={resetToAdmin} isLoading={deactivating}>
                                {deactivating ? 'Stopping…' : 'Stop serving anyway'}
                            </Button>
                        </div>
                    </div>
                )}
            </Modal>

            <Modal isOpen={showEmergencyConfirm} onClose={() => !emergencyStopping && setShowEmergencyConfirm(false)}
                title="Stop everything and kill ComfyUI?" maxWidth="max-w-md">
                <div className="space-y-4">
                    <p className="text-sm text-slate-300">
                        This will:
                    </p>
                    <ul className="text-sm text-slate-300 space-y-1.5 list-disc pl-5">
                        <li>Cancel every scheduled job</li>
                        <li>Mark every in-flight job as failed (<code className="text-xs">emergency-stop</code>)</li>
                        <li>Kill the ComfyUI process if ComfyQ spawned it (external attached ComfyUI is left alone)</li>
                        <li>Switch the server to admin mode and restart it</li>
                    </ul>
                    <p className="text-xs text-warning">
                        Use this when something is stuck or generating something it shouldn't.
                    </p>
                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={() => setShowEmergencyConfirm(false)}
                            disabled={emergencyStopping}>Cancel</Button>
                        <Button variant="danger" icon={OctagonAlert} onClick={emergencyStop}
                            isLoading={emergencyStopping}>
                            {emergencyStopping ? 'Stopping…' : 'Yes, stop everything'}
                        </Button>
                    </div>
                </div>
            </Modal>

            <Modal isOpen={showTakeoverConfirm} onClose={() => !comfyBusy && setShowTakeoverConfirm(false)}
                title="Restart & take over ComfyUI?" maxWidth="max-w-md">
                <div className="space-y-4">
                    <p className="text-sm text-slate-300">
                        ComfyUI is running <strong className="text-white">outside ComfyQ</strong> right now. Restarting it will:
                    </p>
                    <ul className="text-sm text-slate-300 space-y-1.5 list-disc pl-5">
                        <li>Force-stop the ComfyUI listening on port <code className="text-xs">{config?.comfy_ui?.api_port || 8188}</code> (the one you started manually)</li>
                        <li>Relaunch it under ComfyQ from the configured paths{(config?.comfy_ui?.lan_access ?? false) ? ', bound to the LAN' : ', on localhost'}</li>
                        <li>Leave ComfyQ managing it — so Restart, Stop, and “Open in ComfyUI” work from here afterward</li>
                    </ul>
                    <p className="text-xs text-warning">
                        Any generation in progress on that ComfyUI will be interrupted. Takes ~30–90&nbsp;s to come back up.
                    </p>
                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={() => setShowTakeoverConfirm(false)} disabled={comfyBusy}>Cancel</Button>
                        <Button variant="secondary" icon={RefreshCw} onClick={restartComfy} isLoading={comfyBusy}>
                            {comfyBusy ? 'Restarting…' : 'Yes, restart & take over'}
                        </Button>
                    </div>
                </div>
            </Modal>

            <Modal isOpen={!!confirmValidateId} onClose={() => !validatingId && setConfirmValidateId(null)}
                title="Validate this workflow?" maxWidth="max-w-md">
                <div className="space-y-4">
                    <p className="text-sm text-slate-300">
                        Remove the <strong className="text-warning">Experimental</strong> tag from
                        <code className="mx-1 px-1.5 py-0.5 bg-surface rounded text-primary">{confirmValidateId}</code>?
                    </p>
                    <p className="text-xs text-muted">
                        Do this once you've run it yourself and are happy with the results. The flag is cleared in the
                        bundle's <code>meta.json</code>, so the change is saved with the workflow. You can mark it
                        experimental again from <strong>Edit metadata</strong>.
                    </p>
                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={() => setConfirmValidateId(null)} disabled={!!validatingId}>Cancel</Button>
                        <Button variant="primary" icon={ShieldCheck} onClick={() => validateWorkflow(confirmValidateId)}
                            isLoading={validatingId === confirmValidateId}>
                            {validatingId ? 'Validating…' : 'Validate workflow'}
                        </Button>
                    </div>
                </div>
            </Modal>

            <Modal isOpen={!!deletingWorkflowId} onClose={() => setDeletingWorkflowId(null)}
                title="Delete workflow?" maxWidth="max-w-md">
                <div className="space-y-4">
                    <p className="text-sm text-slate-300">
                        This will permanently delete the workflow folder
                        <code className="mx-1 px-1.5 py-0.5 bg-surface rounded text-primary">{deletingWorkflowId}</code>
                        including its <code>api.json</code>, <code>meta.json</code>, and any calibration data.
                    </p>
                    <p className="text-xs text-muted">
                        Existing job records that reference this workflow will remain in the queue but won't be runnable.
                    </p>
                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={() => setDeletingWorkflowId(null)}>Cancel</Button>
                        <Button variant="danger" icon={Trash2} onClick={() => deleteWorkflow(deletingWorkflowId)}>
                            Delete workflow
                        </Button>
                    </div>
                </div>
            </Modal>


            <Modal isOpen={showCleanupConfirm} onClose={() => !cleaningOutputs && setShowCleanupConfirm(false)}
                title="Delete all output files?" maxWidth="max-w-md">
                <div className="space-y-4">
                    <div className="flex items-start gap-3">
                        <AlertTriangle size={20} className="text-danger shrink-0 mt-0.5" />
                        <p className="text-sm text-slate-300">
                            This permanently deletes every output file (images, videos, audio) referenced by completed jobs in this deployment, across all users. Job records are kept for history but their <code>outputs</code> field is cleared.
                        </p>
                    </div>
                    <p className="text-xs text-warning">
                        This action cannot be undone. Make sure students have downloaded anything they want to keep.
                    </p>
                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={() => setShowCleanupConfirm(false)}
                            disabled={cleaningOutputs}>Cancel</Button>
                        <Button variant="danger" icon={Eraser} onClick={cleanupOutputs}
                            isLoading={cleaningOutputs}>
                            {cleaningOutputs ? 'Cleaning…' : 'Yes, delete all outputs'}
                        </Button>
                    </div>
                </div>
            </Modal>


            <Modal isOpen={showClearHistoryConfirm} onClose={() => !clearingHistory && setShowClearHistoryConfirm(false)}
                title="Delete all job history?" maxWidth="max-w-md">
                <div className="space-y-4">
                    <div className="flex items-start gap-3">
                        <AlertTriangle size={20} className="text-danger shrink-0 mt-0.5" />
                        <p className="text-sm text-slate-300">
                            This permanently removes every finished job record (prompts, timestamps, users, events) across all users, and deletes the output files those jobs produced. Scheduled and in-flight jobs are preserved.
                        </p>
                    </div>
                    <p className="text-xs text-warning">
                        This action cannot be undone. Make sure students have downloaded anything they want to keep.
                    </p>
                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={() => setShowClearHistoryConfirm(false)}
                            disabled={clearingHistory}>Cancel</Button>
                        <Button variant="danger" icon={Trash2} onClick={clearHistory}
                            isLoading={clearingHistory}>
                            {clearingHistory ? 'Clearing…' : 'Yes, delete all history'}
                        </Button>
                    </div>
                </div>
            </Modal>

            {/* Storyboard batches — one markdown document becomes a whole queue of
                generations (images, then the videos that consume them, then audio).
                See docs/storyboard-format.md. */}


        </div>
    );
};

const Field = ({ label, value, onChange, type = 'text', placeholder, children }) => (
    <div className="space-y-1.5">
        <label className="text-xs uppercase tracking-wider text-muted font-semibold">{label}</label>
        <input
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full bg-background border border-border rounded-lg p-2.5 text-white font-mono text-sm"
        />
        {children}
    </div>
);

export default AdminConfig;
